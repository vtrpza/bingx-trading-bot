import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'
import type { Asset, Trade, PaginatedResponse } from '../types'

interface CacheEntry {
  data: any
  timestamp: number
  ttl: number
}

interface BatchRequest {
  url: string
  resolve: (value: any) => void
  reject: (reason?: any) => void
  config?: AxiosRequestConfig
}

class OptimizedAPI {
  private client: AxiosInstance
  private cache: Map<string, CacheEntry> = new Map()
  private batchQueue: Map<string, BatchRequest[]> = new Map()
  private batchTimeout: number = 50 // ms
  private batchTimer: NodeJS.Timeout | null = null
  private requestDeduplication: Map<string, Promise<any>> = new Map()
  
  // Performance metrics
  private metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    batchedRequests: 0,
    deduplicatedRequests: 0,
    totalRequests: 0
  }

  constructor() {
    const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'
    
    this.client = axios.create({
      baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    // Add request interceptor for metrics
    this.client.interceptors.request.use((config) => {
      this.metrics.totalRequests++
      return config
    })

    // Add response interceptor for caching
    this.client.interceptors.response.use(
      (response) => {
        // Cache successful GET responses
        if (response.config.method === 'get' && response.status === 200) {
          const cacheKey = this.getCacheKey(response.config)
          const ttl = this.getCacheTTL(response.config.url || '')
          
          if (ttl > 0) {
            this.cache.set(cacheKey, {
              data: response.data,
              timestamp: Date.now(),
              ttl
            })
          }
        }
        return response
      },
      (error) => {
        // Clear cache on error
        if (error.config) {
          const cacheKey = this.getCacheKey(error.config)
          this.cache.delete(cacheKey)
        }
        return Promise.reject(error)
      }
    )

    // Start cache cleanup interval
    setInterval(() => this.cleanupCache(), 60 * 1000) // Every minute
  }

  private getCacheKey(config: AxiosRequestConfig): string {
    const params = config.params ? JSON.stringify(config.params) : ''
    return `${config.method}:${config.url}:${params}`
  }

  private getCacheTTL(url: string): number {
    // Different TTLs for different endpoints
    if (url.includes('/assets/stats')) return 60 * 1000 // 1 minute
    if (url.includes('/assets')) return 30 * 1000 // 30 seconds
    if (url.includes('/trades')) return 10 * 1000 // 10 seconds
    if (url.includes('/bot/status')) return 5 * 1000 // 5 seconds
    return 0 // No cache by default
  }

  private cleanupCache(): void {
    const now = Date.now()
    let cleaned = 0
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
        cleaned++
      }
    }
    
    if (cleaned > 0) {
      console.debug(`[API Cache] Cleaned ${cleaned} expired entries`)
    }
  }

  private async getCached<T>(
    key: string, 
    fetcher: () => Promise<T>, 
    ttl?: number
  ): Promise<T> {
    const cached = this.cache.get(key)
    
    if (cached && Date.now() - cached.timestamp < cached.ttl) {
      this.metrics.cacheHits++
      return cached.data as T
    }
    
    this.metrics.cacheMisses++
    
    // Check for in-flight request
    const inFlight = this.requestDeduplication.get(key)
    if (inFlight) {
      this.metrics.deduplicatedRequests++
      return inFlight
    }
    
    // Create new request
    const promise = fetcher().finally(() => {
      this.requestDeduplication.delete(key)
    })
    
    this.requestDeduplication.set(key, promise)
    return promise
  }

  private async batchRequest(url: string, config?: AxiosRequestConfig): Promise<any> {
    return new Promise((resolve, reject) => {
      const requests = this.batchQueue.get(url) || []
      requests.push({ url, resolve, reject, config })
      this.batchQueue.set(url, requests)
      
      // Clear existing timer
      if (this.batchTimer) {
        clearTimeout(this.batchTimer)
      }
      
      // Set new batch timer
      this.batchTimer = setTimeout(() => {
        this.processBatchQueue()
      }, this.batchTimeout)
    })
  }

  private async processBatchQueue(): Promise<void> {
    const queue = new Map(this.batchQueue)
    this.batchQueue.clear()
    
    for (const [url, requests] of queue) {
      if (requests.length === 0) continue
      
      this.metrics.batchedRequests += requests.length
      
      try {
        // Use the first request's config
        const response = await this.client.get(url, requests[0].config)
        
        // Resolve all requests with the same data
        requests.forEach(req => req.resolve(response.data))
      } catch (error) {
        // Reject all requests with the same error
        requests.forEach(req => req.reject(error))
      }
    }
  }

  // Public API methods with optimization

  async getAssets(params: {
    page?: number
    limit?: number
    sortBy?: string
    sortOrder?: 'ASC' | 'DESC'
    search?: string
    status?: string
  } = {}): Promise<PaginatedResponse<Asset>> {
    const cacheKey = `get:/assets:${JSON.stringify(params)}`
    
    return this.getCached(
      cacheKey,
      () => this.client.get<PaginatedResponse<Asset>>('/assets', { params }).then(r => r.data),
      30 * 1000 // 30 second cache
    )
  }

  async getAssetStats() {
    const cacheKey = 'get:/assets/stats'
    
    return this.getCached(
      cacheKey,
      () => this.client.get('/assets/stats').then(r => r.data),
      60 * 1000 // 1 minute cache
    )
  }

  async refreshAssets(onProgress?: (data: any) => void) {
    // No caching for refresh operations
    const eventSource = new EventSource(`${this.client.defaults.baseURL}/assets/refresh`)
    
    return new Promise((resolve, reject) => {
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (onProgress) onProgress(data)
          
          if (data.type === 'completed' || data.type === 'error') {
            eventSource.close()
            
            // Clear all asset-related caches
            this.clearCacheByPattern('/assets')
            
            if (data.type === 'completed') {
              resolve(data)
            } else {
              reject(new Error(data.message || 'Refresh failed'))
            }
          }
        } catch (error) {
          console.error('Error parsing SSE data:', error)
        }
      }
      
      eventSource.onerror = (error) => {
        eventSource.close()
        reject(error)
      }
    })
  }

  async refreshAssetsDelta(onProgress?: (data: any) => void) {
    // No caching for refresh operations
    const eventSource = new EventSource(`${this.client.defaults.baseURL}/assets/refresh-delta`)
    
    return new Promise((resolve, reject) => {
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (onProgress) onProgress(data)
          
          if (data.type === 'completed' || data.type === 'error') {
            eventSource.close()
            
            // Clear all asset-related caches
            this.clearCacheByPattern('/assets')
            
            if (data.type === 'completed') {
              resolve(data)
            } else {
              reject(new Error(data.message || 'Refresh failed'))
            }
          }
        } catch (error) {
          console.error('Error parsing SSE data:', error)
        }
      }
      
      eventSource.onerror = (error) => {
        eventSource.close()
        reject(error)
      }
    })
  }

  async clearAllAssets() {
    const response = await this.client.delete('/assets/clear-all')
    
    // Clear all asset-related caches
    this.clearCacheByPattern('/assets')
    
    return response.data
  }

  async getBotStatus() {
    // Use batching for bot status to avoid multiple simultaneous requests
    return this.batchRequest('/bot/status')
  }

  async startBot() {
    const response = await this.client.post('/bot/start')
    
    // Clear bot status cache
    this.clearCacheByPattern('/bot/status')
    
    return response.data
  }

  async stopBot() {
    const response = await this.client.post('/bot/stop')
    
    // Clear bot status cache
    this.clearCacheByPattern('/bot/status')
    
    return response.data
  }

  async updateBotConfig(config: any) {
    const response = await this.client.put('/bot/config', config)
    
    // Clear bot-related caches
    this.clearCacheByPattern('/bot')
    
    return response.data
  }

  async getTrades(params: {
    page?: number
    limit?: number
    sortBy?: string
    sortOrder?: 'ASC' | 'DESC'
  } = {}): Promise<PaginatedResponse<Trade>> {
    const cacheKey = `get:/trades:${JSON.stringify(params)}`
    
    return this.getCached(
      cacheKey,
      () => this.client.get<PaginatedResponse<Trade>>('/trades', { params }).then(r => r.data),
      10 * 1000 // 10 second cache
    )
  }

  async getOpenPositions() {
    const cacheKey = 'get:/trades/positions'
    
    return this.getCached(
      cacheKey,
      () => this.client.get('/trades/positions').then(r => r.data),
      5 * 1000 // 5 second cache
    )
  }

  async closePosition(symbol: string, percentage: number = 100) {
    const response = await this.client.post('/trades/close-position', { symbol, percentage })
    
    // Clear position and trade caches
    this.clearCacheByPattern('/trades')
    
    return response.data
  }

  // Utility methods

  clearCache(): void {
    const size = this.cache.size
    this.cache.clear()
    this.requestDeduplication.clear()
    console.debug(`[API Cache] Cleared ${size} entries`)
  }

  clearCacheByPattern(pattern: string): void {
    let cleared = 0
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key)
        cleared++
      }
    }
    if (cleared > 0) {
      console.debug(`[API Cache] Cleared ${cleared} entries matching pattern: ${pattern}`)
    }
  }

  getMetrics() {
    const cacheHitRate = this.metrics.totalRequests > 0
      ? ((this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses)) * 100).toFixed(2)
      : '0.00'
    
    return {
      ...this.metrics,
      cacheHitRate: `${cacheHitRate}%`,
      cacheSize: this.cache.size,
      inFlightRequests: this.requestDeduplication.size
    }
  }

  // WebSocket connection for real-time updates
  connectWebSocket(onMessage: (data: any) => void): () => void {
    const wsUrl = this.client.defaults.baseURL?.replace('http', 'ws').replace('/api', '') || ''
    const ws = new WebSocket(wsUrl)
    
    ws.onopen = () => {
      console.log('[WebSocket] Connected')
    }
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        onMessage(data)
        
        // Invalidate relevant caches based on WebSocket events
        if (data.type === 'trade') {
          this.clearCacheByPattern('/trades')
        } else if (data.type === 'position') {
          this.clearCacheByPattern('/trades/positions')
        } else if (data.type === 'bot_status') {
          this.clearCacheByPattern('/bot/status')
        }
      } catch (error) {
        console.error('[WebSocket] Error parsing message:', error)
      }
    }
    
    ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error)
    }
    
    ws.onclose = () => {
      console.log('[WebSocket] Disconnected')
    }
    
    // Return cleanup function
    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
    }
  }
}

export const apiOptimized = new OptimizedAPI()

// Export metrics for monitoring
if (import.meta.env.DEV) {
  (window as any).__API_METRICS__ = () => apiOptimized.getMetrics()
}