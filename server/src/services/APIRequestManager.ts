import { bingxClient } from './bingxClient';
import { logger } from '../utils/logger';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiry: number;
}

interface PendingRequest {
  promise: Promise<any>;
  timestamp: number;
}

interface RequestQueueItem {
  key: string;
  method: string;
  params: any[];
  priority: number;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timestamp: number;
}

export enum RequestPriority {
  CRITICAL = 1,  // Trading operations
  HIGH = 2,      // Balance, positions
  MEDIUM = 3,    // Market data for active trading
  LOW = 4        // Background data, analytics
}

/**
 * Centralized API Request Manager for BingX
 * Implements intelligent caching, request deduplication, and rate limit management
 */
export class APIRequestManager {
  private cache = new Map<string, CacheEntry<any>>();
  private pendingRequests = new Map<string, PendingRequest>();
  private requestQueue: RequestQueueItem[] = [];
  private isProcessingQueue = false;
  
  // Cache durations in milliseconds - ULTRA OPTIMIZED
  private cacheDurations = {
    balance: 45000,       // 45 seconds - faster updates
    positions: 20000,     // 20 seconds - near real-time positions  
    klines: 90000,        // 1.5 minutes - reduce API load
    ticker: 15000,        // 15 seconds - fast price updates
    symbols: 300000,      // 5 minutes - rarely changes
    openOrders: 10000,    // 10 seconds - faster order tracking
    depth: 8000           // 8 seconds - faster order book
  };

  // Request spacing - ULTRA OPTIMIZED
  private readonly requestSpacing = 300; // 0.3 seconds between requests
  private readonly queueTimeout = 8000; // 8 second queue timeout
  private lastRequestTime = 0;

  /**
   * Main method to make API requests with intelligent caching and queueing
   */
  async makeRequest<T>(
    method: string, 
    params: any[] = [], 
    priority: RequestPriority = RequestPriority.MEDIUM,
    cacheKey?: string
  ): Promise<T> {
    const key = cacheKey || this.generateCacheKey(method, params);
    
    // Check cache first
    const cached = this.getFromCache<T>(key);
    if (cached) {
      logger.debug(`Cache hit for ${key}`);
      return cached;
    }

    // Check for pending identical request
    if (this.pendingRequests.has(key)) {
      logger.debug(`Deduplicating request for ${key}`);
      return this.pendingRequests.get(key)!.promise;
    }

    // Queue the request
    return new Promise<T>((resolve, reject) => {
      this.requestQueue.push({
        key,
        method,
        params,
        priority,
        resolve,
        reject,
        timestamp: Date.now()
      });

      // Sort queue by priority
      this.requestQueue.sort((a, b) => a.priority - b.priority || a.timestamp - b.timestamp);

      // Start processing if not already running
      if (!this.isProcessingQueue) {
        this.processQueue();
      }
    });
  }

  /**
   * Process the request queue with proper rate limiting
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    
    this.isProcessingQueue = true;
    
    while (this.requestQueue.length > 0) {
      const item = this.requestQueue.shift()!;
      
      try {
        // Enforce rate limiting
        await this.enforceRateLimit();
        
        // Check if request is too old (use configurable timeout)
        if (Date.now() - item.timestamp > this.queueTimeout) {
          logger.warn(`Dropping old request: ${item.key}`);
          item.reject(new Error('Request timeout in queue'));
          continue;
        }

        // Create pending request entry
        const requestPromise = this.executeRequest(item.method, item.params);
        this.pendingRequests.set(item.key, {
          promise: requestPromise,
          timestamp: Date.now()
        });

        try {
          const result = await requestPromise;
          
          // Cache the result
          this.setCache(item.key, result, this.getCacheDuration(item.method));
          
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        } finally {
          // Clean up pending request
          this.pendingRequests.delete(item.key);
        }

      } catch (error) {
        item.reject(error);
      }
    }
    
    this.isProcessingQueue = false;
  }

  /**
   * Enforce conservative rate limiting
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.requestSpacing) {
      const waitTime = this.requestSpacing - timeSinceLastRequest;
      logger.debug(`Rate limiting: waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Execute the actual API request
   */
  private async executeRequest(method: string, params: any[]): Promise<any> {
    logger.debug(`Executing API request: ${method}`, { params });
    
    switch (method) {
      case 'getBalance':
        return bingxClient.getBalance();
      case 'getPositions':
        return bingxClient.getPositions(params[0]);
      case 'getKlines':
        return bingxClient.getKlines(params[0], params[1], params[2]);
      case 'getTicker':
        return bingxClient.getTicker(params[0]);
      case 'getSymbols':
        return bingxClient.getSymbols();
      case 'getOpenOrders':
        return bingxClient.getOpenOrders(params[0]);
      case 'getDepth':
        return bingxClient.getDepth(params[0], params[1]);
      default:
        throw new Error(`Unknown API method: ${method}`);
    }
  }

  /**
   * Generate cache key for request
   */
  private generateCacheKey(method: string, params: any[]): string {
    return `${method}:${JSON.stringify(params)}`;
  }

  /**
   * Get cache duration for method
   */
  private getCacheDuration(method: string): number {
    const baseName = method.replace('get', '').toLowerCase();
    return this.cacheDurations[baseName as keyof typeof this.cacheDurations] || 60000;
  }

  /**
   * Get data from cache if still valid
   */
  private getFromCache<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data as T;
  }

  /**
   * Set data in cache
   */
  private setCache<T>(key: string, data: T, duration: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      expiry: Date.now() + duration
    });
  }

  /**
   * Convenience methods for common API calls
   */
  async getBalance() {
    return this.makeRequest('getBalance', [], RequestPriority.HIGH);
  }

  async getPositions(symbol?: string) {
    return this.makeRequest('getPositions', [symbol], RequestPriority.HIGH);
  }

  async getKlines(symbol: string, interval: string, limit: number = 100) {
    return this.makeRequest('getKlines', [symbol, interval, limit], RequestPriority.MEDIUM);
  }

  async getTicker(symbol: string) {
    return this.makeRequest('getTicker', [symbol], RequestPriority.MEDIUM);
  }

  async getSymbols() {
    return this.makeRequest('getSymbols', [], RequestPriority.LOW);
  }

  async getOpenOrders(symbol?: string) {
    return this.makeRequest('getOpenOrders', [symbol], RequestPriority.MEDIUM);
  }

  async getDepth(symbol: string, limit: number = 20) {
    return this.makeRequest('getDepth', [symbol, limit], RequestPriority.LOW);
  }

  /**
   * Emergency cache clear (useful during circuit breaker recovery)
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('API request cache cleared');
  }

  /**
   * Get cache and queue statistics
   */
  getStatus() {
    // Clean expired cache entries
    const now = Date.now();
    let expired = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) {
        this.cache.delete(key);
        expired++;
      }
    }

    return {
      cache: {
        size: this.cache.size,
        expired
      },
      queue: {
        pending: this.requestQueue.length,
        processing: this.isProcessingQueue
      },
      pendingRequests: this.pendingRequests.size,
      lastRequestTime: this.lastRequestTime,
      requestSpacing: this.requestSpacing
    };
  }

  /**
   * Clean up expired cache entries and old pending requests
   */
  cleanup(): void {
    const now = Date.now();
    
    // Clean expired cache
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) {
        this.cache.delete(key);
      }
    }

    // Clean old pending requests (over 60 seconds)
    for (const [key, request] of this.pendingRequests.entries()) {
      if (now - request.timestamp > 60000) {
        this.pendingRequests.delete(key);
      }
    }
  }

  /**
   * Force refresh specific cache entry
   */
  invalidateCache(pattern?: string): void {
    if (!pattern) {
      this.clearCache();
      return;
    }

    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }

    logger.info(`Invalidated cache entries matching: ${pattern}`);
  }
}

// Global singleton instance
export const apiRequestManager = new APIRequestManager();

// Auto cleanup every 5 minutes
setInterval(() => {
  apiRequestManager.cleanup();
}, 300000);