import axios, { AxiosRequestConfig, CancelTokenSource } from 'axios'
import type { 
  Asset, 
  Trade, 
  Position, 
  TradingSignal, 
  BotStatus, 
  BotConfig,
  MarketData,
  Candle,
  TechnicalIndicators,
  PaginatedResponse,
  ActivityEvent
} from '../types'

// Request deduplication cache
const requestCache = new Map<string, Promise<any>>()
const cancelTokens = new Map<string, CancelTokenSource>()

// Performance optimized axios instance
const axiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000, // Reduced from 5 minutes to 30 seconds
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br'
  },
  // Enable compression
  decompress: true,
})

// Request deduplication helper
function createCacheKey(url: string, params?: any): string {
  return `${url}${params ? JSON.stringify(params) : ''}`
}

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 5000,
  backoffFactor: 2,
}

// Exponential backoff retry helper
async function withRetry<T>(fn: () => Promise<T>, retries = RETRY_CONFIG.maxRetries): Promise<T> {
  try {
    return await fn()
  } catch (error: any) {
    if (retries > 0 && error.response?.status >= 500) {
      const delay = Math.min(
        RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffFactor, RETRY_CONFIG.maxRetries - retries),
        RETRY_CONFIG.maxDelay
      )
      await new Promise(resolve => setTimeout(resolve, delay))
      return withRetry(fn, retries - 1)
    }
    throw error
  }
}

// Configuration for SSE - can be disabled if problematic
const SSE_CONFIG = {
  enabled: true,
  timeout: 10000, // 10 seconds
  retryDelay: 500, // 500ms delay before starting request
  maxErrors: 3 // Disable SSE after 3 consecutive errors
}

// Track SSE errors to auto-disable if problematic
let sseErrorCount = 0

// Performance optimized request interceptor
axiosInstance.interceptors.request.use(
  (config) => {
    // Add request timestamp for performance monitoring
    config.metadata = { startTime: Date.now() }
    
    // Set appropriate timeout based on endpoint
    if (config.url?.includes('/refresh')) {
      config.timeout = 120000 // 2 minutes for refresh operations
    } else if (config.url?.includes('/trades/history')) {
      config.timeout = 15000 // 15 seconds for history
    } else {
      config.timeout = 10000 // 10 seconds for regular requests
    }
    
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Performance optimized response interceptor
axiosInstance.interceptors.response.use(
  (response) => {
    // Log performance metrics
    const duration = Date.now() - response.config.metadata?.startTime
    if (duration > 5000) {
      console.warn(`Slow API request: ${response.config.url} took ${duration}ms`)
    }
    
    // Clean up cache entry
    const cacheKey = createCacheKey(response.config.url || '', response.config.params)
    requestCache.delete(cacheKey)
    
    // For API responses with format { success: true, data: {...} }, return the data field directly
    if (response.data && response.data.success && response.data.data !== undefined) {
      return {
        ...response,
        data: response.data.data
      }
    }
    return response
  },
  (error) => {
    // Clean up cache and cancel tokens on error
    const cacheKey = createCacheKey(error.config?.url || '', error.config?.params)
    requestCache.delete(cacheKey)
    cancelTokens.delete(cacheKey)
    
    // Enhanced error handling with retry logic for 5xx errors
    const message = error.response?.data?.error?.message || 
                   error.response?.data?.msg || 
                   error.message || 
                   'An error occurred'
    
    // Add context to error
    const enhancedError = new Error(message)
    enhancedError.status = error.response?.status
    enhancedError.url = error.config?.url
    
    throw enhancedError
  }
)

// Request deduplication wrapper
function deduplicateRequest<T>(key: string, requestFn: () => Promise<T>): Promise<T> {
  if (requestCache.has(key)) {
    return requestCache.get(key)!
  }
  
  const promise = requestFn().finally(() => {
    requestCache.delete(key)
  })
  
  requestCache.set(key, promise)
  return promise
}

// Cancellable request wrapper
function makeCancellableRequest<T>(key: string, config: AxiosRequestConfig): Promise<T> {
  // Cancel previous request with same key if exists
  const existingToken = cancelTokens.get(key)
  if (existingToken) {
    existingToken.cancel('Replaced by newer request')
  }
  
  // Create new cancel token
  const source = axios.CancelToken.source()
  cancelTokens.set(key, source)
  
  return axiosInstance({ ...config, cancelToken: source.token })
    .finally(() => {
      cancelTokens.delete(key)
    })
}

export const api = {
  // Assets - Optimized with caching and deduplication
  async getAssets(params?: {
    page?: number
    limit?: number
    sortBy?: string
    sortOrder?: 'ASC' | 'DESC'
    search?: string
    status?: string
  }): Promise<PaginatedResponse<Asset>> {
    const cacheKey = createCacheKey('/assets', params)
    return deduplicateRequest(cacheKey, () => 
      withRetry(() => axiosInstance.get('/assets', { params }))
    )
  },

  async getAllAssets(params?: {
    sortBy?: string
    sortOrder?: 'ASC' | 'DESC'
    search?: string
    status?: string
  }): Promise<{
    assets: Asset[]
    count: number
    executionTime: string
    lastUpdated: string
  }> {
    const cacheKey = createCacheKey('/assets/all', params)
    return deduplicateRequest(cacheKey, () => 
      withRetry(() => axiosInstance.get('/assets/all', { params }))
    )
  },

  async getAsset(symbol: string): Promise<Asset> {
    const cacheKey = createCacheKey(`/assets/${symbol}`)
    return deduplicateRequest(cacheKey, () => 
      withRetry(() => axiosInstance.get(`/assets/${symbol}`))
    )
  },

  async refreshAssetsDelta(onProgress?: (data: any) => void): Promise<{ message: string; created: number; updated: number; total: number; processed: number; skipped: number; sessionId: string; deltaMode?: string }> {
    const sessionId = `delta_refresh_${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      let eventSource: EventSource | null = null;
      
      // Connect to SSE for progress updates
      if (onProgress && SSE_CONFIG.enabled) {
        const sseUrl = `/api/assets/refresh/progress/${sessionId}`;
        console.log('🔌 Delta refresh SSE:', sseUrl);
        eventSource = new EventSource(sseUrl);
        
        eventSource.onopen = () => {
          console.log('✅ Delta SSE connected');
          // Reset error count on successful connection
          sseErrorCount = 0;
        };

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('📡 Delta SSE received:', data);
            
            if (data.type === 'heartbeat') {
              console.log('💓 Delta heartbeat');
              return;
            }
            
            if (data.type !== 'connected') {
              console.log('🔄 Delta progress to UI:', data);
              onProgress(data);
            }
            
            if (data.type === 'completed' || data.type === 'error') {
              console.log('🔚 Delta SSE closing...');
              eventSource?.close();
            }
          } catch (error) {
            console.error('❌ Delta SSE parse error:', error, 'Raw data:', event.data);
          }
        };
        
        eventSource.onerror = (error) => {
          console.error('❌ Delta SSE connection error:', error);
          sseErrorCount++;
          
          // Try to get more details about the error
          if (eventSource?.readyState === EventSource.CLOSED) {
            console.warn('⚠️ SSE connection was closed by server');
          } else if (eventSource?.readyState === EventSource.CONNECTING) {
            console.warn('⚠️ SSE connection is still trying to connect');
          }
          
          // Auto-disable SSE if too many errors
          if (sseErrorCount >= SSE_CONFIG.maxErrors) {
            console.warn(`⚠️ Too many SSE errors (${sseErrorCount}), disabling SSE`);
            SSE_CONFIG.enabled = false;
          }
          
          // Don't reject immediately, let the request continue without SSE
          // The HTTP request will still work even if SSE fails
        };
      }
      
      // Add timeout to close SSE if it takes too long
      const sseTimeout = setTimeout(() => {
        if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
          console.warn('⏰ SSE timeout - closing connection');
          eventSource.close();
        }
      }, SSE_CONFIG.timeout);
      
      // Start delta refresh
      setTimeout(async () => {
        try {
          console.log('🚀 Starting delta refresh with sessionId:', sessionId);
          const response = await axiosInstance.post('/assets/refresh/delta', { sessionId });
          console.log('✅ Delta refresh response:', response.data);
          clearTimeout(sseTimeout);
          eventSource?.close();
          resolve(response.data);
        } catch (error) {
          console.error('❌ Delta refresh error:', error);
          clearTimeout(sseTimeout);
          eventSource?.close();
          reject(error);
        }
      }, 500);
    });
  },

  async refreshAssets(onProgress?: (data: any) => void): Promise<{ message: string; created: number; updated: number; total: number; processed: number; skipped: number; sessionId: string }> {
    const sessionId = `refresh_${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      let eventSource: EventSource | null = null;
      
      // Connect to SSE for progress updates
      if (onProgress && SSE_CONFIG.enabled) {
        // Usar URL relativa para evitar problemas de CORS
        const sseUrl = `/api/assets/refresh/progress/${sessionId}`;
        console.log('🔌 Conectando SSE:', sseUrl);
        eventSource = new EventSource(sseUrl);
        
        eventSource.onopen = () => {
          console.log('✅ SSE conectado com sucesso!');
          // Reset error count on successful connection
          sseErrorCount = 0;
        };

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('📡 SSE recebido:', data);
            
            // Skip connection and heartbeat messages, but log heartbeat for debugging
            if (data.type === 'heartbeat') {
              console.log('💓 Heartbeat recebido - conexão SSE ativa');
              return;
            }
            
            if (data.type !== 'connected') {
              console.log('🔄 Enviando progresso para UI:', data);
              onProgress(data);
            }
            
            // Close connection when completed
            if (data.type === 'completed' || data.type === 'error') {
              console.log('🔚 SSE finalizando...');
              eventSource?.close();
            }
          } catch (error) {
            console.error('❌ Erro ao parsear SSE:', error, 'Raw data:', event.data);
          }
        };
        
        eventSource.onerror = (error) => {
          console.error('❌ SSE erro de conexão:', error);
          console.log('📊 SSE readyState:', eventSource?.readyState);
          sseErrorCount++;
          
          // Try to get more details about the error
          if (eventSource?.readyState === EventSource.CLOSED) {
            console.warn('⚠️ SSE connection was closed by server');
          } else if (eventSource?.readyState === EventSource.CONNECTING) {
            console.warn('⚠️ SSE connection is still trying to connect');
          }
          
          // Auto-disable SSE if too many errors
          if (sseErrorCount >= SSE_CONFIG.maxErrors) {
            console.warn(`⚠️ Too many SSE errors (${sseErrorCount}), disabling SSE`);
            SSE_CONFIG.enabled = false;
          }
          
          // Don't reject immediately, let the request continue without SSE
        };
      }
      
      // Add timeout to close SSE if it takes too long
      const sseTimeout = setTimeout(() => {
        if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
          console.warn('⏰ SSE timeout - closing connection');
          eventSource.close();
        }
      }, SSE_CONFIG.timeout);
      
      // Wait a bit for SSE connection to establish, then start refresh
      setTimeout(async () => {
        try {
          console.log('🚀 Iniciando refresh com sessionId:', sessionId);
          const response = await axiosInstance.post('/assets/refresh', { sessionId });
          console.log('✅ Refresh response:', response.data);
          clearTimeout(sseTimeout);
          eventSource?.close();
          resolve(response.data);
        } catch (error) {
          console.error('❌ Erro no refresh:', error);
          clearTimeout(sseTimeout);
          eventSource?.close();
          reject(error);
        }
      }, SSE_CONFIG.retryDelay);
    });
  },

  async getAssetStats(): Promise<{
    totalAssets: number
    tradingAssets: number
    topGainers: Asset[]
    topLosers: Asset[]
    topVolume: Asset[]
  }> {
    return axiosInstance.get('/assets/stats/overview')
  },

  async invalidateCache(): Promise<{
    message: string
    timestamp: string
  }> {
    console.log('🔄 API: Invalidating server cache')
    try {
      const response = await axiosInstance.post('/assets/cache/invalidate')
      console.log('✅ API: Cache invalidation response:', response.data)
      return response.data
    } catch (error: any) {
      console.error('❌ API: Cache invalidation error:', error)
      throw error
    }
  },

  async updateCoinNames(): Promise<{
    message: string
    totalAssets: number
    updated: number
    cacheInfo: any
  }> {
    console.log('🪙 API: Updating coin names from external source')
    try {
      const response = await axiosInstance.post('/assets/update-coin-names')
      console.log('✅ API: Coin names updated:', response.data)
      return response.data
    } catch (error: any) {
      console.error('❌ API: Coin names update error:', error)
      throw error
    }
  },

  async clearAllAssets(): Promise<{
    message: string
    deletedCount: number
  }> {
    console.log('🔄 API: Chamando DELETE /assets/clear')
    try {
      const response = await axiosInstance.delete('/assets/clear')
      console.log('✅ API: Resposta completa recebida:', response)
      console.log('✅ API: response.data:', response.data)
      console.log('✅ API: response.status:', response.status)
      
      // O response interceptor já extraiu response.data.data, então response.data contém { message, deletedCount }
      const result = response.data
      console.log('✅ API: Resultado final:', result)
      return result
    } catch (error: any) {
      console.error('❌ API: Erro ao limpar banco:', error)
      console.error('❌ API: error.response:', error.response)
      console.error('❌ API: error.message:', error.message)
      throw error
    }
  },

  // Trading Bot - Optimized with cancellation support
  async getBotStatus(): Promise<any> {
    const cacheKey = '/trading/parallel-bot/status'
    return makeCancellableRequest(cacheKey, {
      method: 'GET',
      url: '/trading/parallel-bot/status'
    })
  },

  async startBot(): Promise<{ message: string }> {
    return axiosInstance.post('/trading/bot/start')
  },

  async stopBot(): Promise<{ message: string }> {
    return axiosInstance.post('/trading/bot/stop')
  },

  async getBotLogs(params?: {
    limit?: number
    level?: 'all' | 'error'
  }): Promise<{
    timestamp: string
    level: string
    message: string
    service: string
  }[]> {
    return axiosInstance.get('/trading/bot/logs', { params })
  },

  async updateBotConfig(config: Partial<BotConfig>): Promise<{ message: string; config: Partial<BotConfig> }> {
    return axiosInstance.put('/trading/bot/config', config)
  },

  async getBotFlowState(): Promise<{
    currentStep: string
    steps: any[]
    activeSignals: any[]
    executionQueue: any[]
    metrics: any
    lastUpdate: number
  }> {
    return axiosInstance.get('/trading/bot/flow-state')
  },

  async getBotActivityEvents(limit?: number): Promise<ActivityEvent[]> {
    return axiosInstance.get('/trading/bot/activity-events', { params: { limit } })
  },

  async getBotProcessMetrics(): Promise<{
    scanningRate: number
    signalGenerationRate: number
    executionSuccessRate: number
    averageProcessingTime: {
      scanning: number
      analysis: number
      decision: number
      execution: number
    }
    performance: {
      totalScanned: number
      signalsGenerated: number
      tradesExecuted: number
      errors: number
    }
    bottlenecks: string[]
  }> {
    return axiosInstance.get('/trading/bot/process-metrics')
  },

  async getPositions(): Promise<Position[]> {
    const cacheKey = '/trading/positions'
    return makeCancellableRequest(cacheKey, {
      method: 'GET',
      url: '/trading/positions'
    })
  },

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const cacheKey = createCacheKey('/trading/orders/open', { symbol })
    return makeCancellableRequest(cacheKey, {
      method: 'GET',
      url: '/trading/orders/open',
      params: { symbol }
    })
  },

  async getTradeHistory(params?: {
    page?: number
    limit?: number
    symbol?: string
    status?: string
    startDate?: string
    endDate?: string
  }): Promise<PaginatedResponse<Trade>> {
    return axiosInstance.get('/trading/trades/history', { params })
  },

  async getTradingStats(period?: string): Promise<{
    period: string
    totalTrades: number
    winningTrades: number
    losingTrades: number
    winRate: string
    totalPnl: string
    totalVolume: string
    averagePnl: string
    bestTrade: any
    worstTrade: any
    // Enhanced data from parallel bot
    positions?: {
      currentActive: number
      metrics: {
        totalPositions: number
        activePositions: number
        closedPositions: number
        totalPnL: number
        winRate: number
        avgHoldTime: number
        stopLossTriggered: number
        takeProfitTriggered: number
        manuallyClosedCount: number
      }
    }
    bot?: {
      isRunning: boolean
      architecture: 'parallel' | 'legacy'
      immediateExecution?: boolean
    }
  }> {
    const cacheKey = createCacheKey('/trading/stats', { period })
    return deduplicateRequest(cacheKey, () => 
      withRetry(() => axiosInstance.get('/trading/stats', { params: { period } }))
    )
  },

  async placeOrder(orderData: {
    symbol: string
    side: 'BUY' | 'SELL'
    quantity: number
    type?: string
    price?: number
    stopLoss?: number
    takeProfit?: number
  }): Promise<any> {
    return axiosInstance.post('/trading/orders', orderData)
  },

  async cancelOrder(orderId: string, symbol: string): Promise<{ message: string }> {
    return axiosInstance.delete(`/trading/orders/${orderId}`, { params: { symbol } })
  },

  // Parallel Bot Specific APIs
  async getParallelBotStatus(): Promise<BotStatus & {
    architecture: 'parallel'
    managedPositions: number
    positionMetrics: any
    immediateExecution: boolean
  }> {
    return axiosInstance.get('/trading/parallel-bot/status')
  },

  async getManagedPositions(): Promise<any[]> {
    return axiosInstance.get('/trading/parallel-bot/positions')
  },

  async getPositionMetrics(): Promise<{
    totalPositions: number
    activePositions: number
    closedPositions: number
    totalPnL: number
    winRate: number
    avgHoldTime: number
    stopLossTriggered: number
    takeProfitTriggered: number
    manuallyClosedCount: number
  }> {
    return axiosInstance.get('/trading/parallel-bot/position-metrics')
  },

  async signalClosePosition(symbol: string): Promise<{ message: string }> {
    return axiosInstance.post(`/trading/parallel-bot/positions/${symbol}/close`)
  },

  async signalCloseAllPositions(): Promise<{ message: string }> {
    return axiosInstance.post('/trading/parallel-bot/positions/close-all')
  },

  async confirmPositionClosed(symbol: string, actualPnl?: number): Promise<{ message: string }> {
    return axiosInstance.post(`/trading/parallel-bot/positions/${symbol}/confirm-closed`, { actualPnl })
  },

  async executeSignalImmediately(symbol: string): Promise<{
    taskId: string | null
    message: string
  }> {
    return axiosInstance.post(`/trading/parallel-bot/execute-immediate/${symbol}`)
  },

  async setImmediateExecutionMode(enabled: boolean): Promise<{ message: string }> {
    return axiosInstance.post('/trading/parallel-bot/immediate-execution', { enabled })
  },

  async getEnhancedTradingStats(period?: string): Promise<{
    period: string
    trading: {
      totalTrades: number
      winningTrades: number
      losingTrades: number
      winRate: string
      totalPnl: string
      totalVolume: string
      averagePnl: string
    }
    positions: {
      current: number
      metrics: any
    }
    bot: {
      isRunning: boolean
      architecture: 'parallel'
      immediateExecution: boolean
    }
  }> {
    return axiosInstance.get('/trading/parallel-bot/enhanced-stats', { params: { period } })
  },

  // Market Data - Optimized with short-term caching
  async getTicker(symbol: string): Promise<MarketData> {
    const cacheKey = `/market-data/ticker/${symbol}`
    return makeCancellableRequest(cacheKey, {
      method: 'GET',
      url: `/market-data/ticker/${symbol}`
    })
  },

  async getKlines(symbol: string, interval?: string, limit?: number): Promise<Candle[]> {
    const cacheKey = createCacheKey(`/market-data/klines/${symbol}`, { interval, limit })
    return deduplicateRequest(cacheKey, () => 
      withRetry(() => axiosInstance.get(`/market-data/klines/${symbol}`, {
        params: { interval, limit }
      }))
    )
  },

  async getDepth(symbol: string, limit?: number): Promise<{
    bids: [number, number][]
    asks: [number, number][]
    lastUpdateId: number
  }> {
    return axiosInstance.get(`/market-data/depth/${symbol}`, { params: { limit } })
  },

  async getIndicators(symbol: string, params?: {
    interval?: string
    limit?: number
    ma1Period?: number
    ma2Period?: number
    rsiPeriod?: number
  }): Promise<{
    symbol: string
    interval: string
    indicators: TechnicalIndicators
    crossovers: any
    volumeAnalysis: any
    validation: any
    series: any
  }> {
    return axiosInstance.get(`/market-data/indicators/${symbol}`, { params })
  },

  async getSignal(symbol: string, interval?: string, limit?: number): Promise<TradingSignal> {
    const cacheKey = createCacheKey(`/market-data/signal/${symbol}`, { interval, limit })
    return makeCancellableRequest(cacheKey, {
      method: 'GET',
      url: `/market-data/signal/${symbol}`,
      params: { interval, limit }
    })
  },

  async getMarketOverview(): Promise<{
    topGainers: any[]
    topLosers: any[]
    topVolume: any[]
    totalSymbols: number
    activeSymbols: number
  }> {
    return axiosInstance.get('/market-data/overview')
  },

  async subscribeToMarketData(subscription: {
    symbol: string
    type: string
    interval?: string
  }): Promise<{ message: string; subscription: any }> {
    return axiosInstance.post('/market-data/subscribe', subscription)
  },

  async unsubscribeFromMarketData(subscription: {
    symbol: string
    type: string
    interval?: string
  }): Promise<{ message: string; subscription: any }> {
    return axiosInstance.post('/market-data/unsubscribe', subscription)
  },
}

// API cleanup utilities
export const apiUtils = {
  // Clear all cached requests
  clearCache(): void {
    requestCache.clear()
  },
  
  // Cancel all pending requests
  cancelAllRequests(): void {
    cancelTokens.forEach((source) => {
      source.cancel('Component unmounted or cleanup requested')
    })
    cancelTokens.clear()
  },
  
  // Cancel specific request by key
  cancelRequest(url: string, params?: any): void {
    const key = createCacheKey(url, params)
    const source = cancelTokens.get(key)
    if (source) {
      source.cancel('Request cancelled')
      cancelTokens.delete(key)
    }
  },
  
  // Get cache statistics
  getCacheStats(): { cacheSize: number; pendingRequests: number } {
    return {
      cacheSize: requestCache.size,
      pendingRequests: cancelTokens.size
    }
  }
}