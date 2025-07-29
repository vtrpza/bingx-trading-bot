/**
 * Comprehensive BingX Rate Limiter
 * Based on official BingX API limits and production best practices
 */
import Bottleneck from 'bottleneck';
import { logger } from '../utils/logger';

export class BingXRateLimiter {
  private marketDataLimiter: Bottleneck;
  private tradingLimiter: Bottleneck;
  private circuitBreaker: CircuitBreaker;
  private cache: Map<string, CacheEntry>;
  private isRateLimited: boolean = false;
  private rateLimitRecoveryTime: number = 0;
  private recoveryTimeoutId: NodeJS.Timeout | null = null;

  constructor() {
    // Market Data Limiter: 100 requests/10 seconds per IP (BingX official limit)
    // OPTIMIZED: Allow 3 concurrent requests with faster timing for batch processing
    this.marketDataLimiter = new Bottleneck({
      maxConcurrent: 3, // Allow 3 parallel requests
      minTime: 80, // 80ms between requests = ~12.5 requests/second total
      reservoir: 90, // Start with 90 tokens (buffer from 100 limit)
      reservoirRefreshAmount: 90,
      reservoirRefreshInterval: 10 * 1000, // Refresh every 10 seconds
      id: 'bingx-market-data-optimized'
    });

    // Trading Operations Limiter: 5 requests/second for orders
    this.tradingLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 250, // 250ms = 4 requests/second (buffer from 5 limit)
      reservoir: 4,
      reservoirRefreshAmount: 4,
      reservoirRefreshInterval: 1000, // Refresh every second
      id: 'bingx-trading'
    });

    // Circuit breaker for handling persistent failures
    this.circuitBreaker = new CircuitBreaker();

    // Cache for reducing API calls
    this.cache = new Map();

    // Setup error handling
    this.setupErrorHandling();

    logger.info('🛡️ BingX Rate Limiter initialized with production limits');
  }

  private setupErrorHandling() {
    this.marketDataLimiter.on('error', (error) => {
      logger.error('Market data limiter error:', error);
    });

    this.tradingLimiter.on('error', (error) => {
      logger.error('Trading limiter error:', error);
    });

    // Log when we're being throttled
    this.marketDataLimiter.on('depleted', (_empty: any) => {
      logger.warn('🚨 Market data rate limit depleted, requests will be queued');
    });

    this.tradingLimiter.on('depleted', (_empty: any) => {
      logger.warn('🚨 Trading rate limit depleted, requests will be queued');
    });
  }

  /**
   * Execute market data request with rate limiting and caching
   */
  async executeMarketDataRequest<T>(
    key: string,
    requestFn: () => Promise<T>,
    cacheSeconds: number = 5
  ): Promise<T> {
    // Check if we're in rate limit recovery period
    if (this.isRateLimited) {
      const remainingTime = this.rateLimitRecoveryTime - Date.now();
      if (remainingTime > 0) {
        throw new Error(`BingX rate limit active. ${Math.ceil(remainingTime / 60000)} minutes remaining until recovery.`);
      } else {
        // Recovery time passed but not cleared - recover now
        this.recoverFromRateLimit();
      }
    }

    // Check cache first
    const cached = this.getFromCache(key, cacheSeconds * 1000);
    if (cached) {
      logger.debug(`📋 Cache hit for ${key}`);
      return cached as T;
    }

    try {
      // Execute with circuit breaker and rate limiting
      return await this.circuitBreaker.execute(async () => {
        return this.marketDataLimiter.schedule(async () => {
          logger.debug(`🌐 API call: ${key}`);
          const result = await requestFn();
          this.setCache(key, result);
          return result;
        });
      });
    } catch (error: any) {
      // If limiter was stopped, try to restart and retry once
      if (error.message?.includes('limiter has been stopped')) {
        logger.warn('🔄 Limiter stopped error, attempting restart and retry...');
        this.restartLimiters();
        
        // Retry once after restart
        return this.circuitBreaker.execute(async () => {
          return this.marketDataLimiter.schedule(async () => {
            logger.debug(`🌐 API call retry: ${key}`);
            const result = await requestFn();
            this.setCache(key, result);
            return result;
          });
        });
      }
      throw error;
    }
  }

  /**
   * Execute batch of market data requests with controlled parallelism
   */
  async executeBatchMarketDataRequests<T>(
    requests: Array<{ key: string; requestFn: () => Promise<T>; cacheSeconds?: number }>
  ): Promise<T[]> {
    // Check cache for all requests first
    const results: (T | null)[] = requests.map(req => {
      const cached = this.getFromCache(req.key, (req.cacheSeconds || 5) * 1000);
      return cached as T | null;
    });
    
    // Find which requests need to be made
    const uncachedRequests = requests.filter((_, index) => results[index] === null);
    
    if (uncachedRequests.length === 0) {
      logger.debug(`📋 All ${requests.length} requests served from cache`);
      return results as T[];
    }
    
    logger.debug(`🚀 Executing ${uncachedRequests.length}/${requests.length} requests in parallel`);
    
    // Execute uncached requests with controlled parallelism
    const promises = uncachedRequests.map(req => 
      this.executeMarketDataRequest(req.key, req.requestFn, req.cacheSeconds)
    );
    
    const uncachedResults = await Promise.all(promises);
    
    // Merge cached and uncached results
    let uncachedIndex = 0;
    return results.map(cached => {
      if (cached !== null) {
        return cached;
      } else {
        return uncachedResults[uncachedIndex++];
      }
    });
  }

  /**
   * Execute trading request with rate limiting
   */
  async executeTradingRequest<T>(
    requestFn: () => Promise<T>
  ): Promise<T> {
    // Check if we're in rate limit recovery period
    if (this.isRateLimited) {
      const remainingTime = this.rateLimitRecoveryTime - Date.now();
      if (remainingTime > 0) {
        throw new Error(`BingX rate limit active. ${Math.ceil(remainingTime / 60000)} minutes remaining until recovery.`);
      } else {
        // Recovery time passed but not cleared - recover now
        this.recoverFromRateLimit();
      }
    }

    try {
      return await this.circuitBreaker.execute(async () => {
        return this.tradingLimiter.schedule(requestFn);
      });
    } catch (error: any) {
      // If limiter was stopped, try to restart and retry once
      if (error.message?.includes('limiter has been stopped')) {
        logger.warn('🔄 Trading limiter stopped error, attempting restart and retry...');
        this.restartLimiters();
        
        // Retry once after restart
        return this.circuitBreaker.execute(async () => {
          return this.tradingLimiter.schedule(requestFn);
        });
      }
      throw error;
    }
  }

  /**
   * Get data from cache if not expired
   */
  private getFromCache<T>(key: string, maxAge: number): T | null {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < maxAge) {
      return entry.data as T;
    }
    return null;
  }

  /**
   * Store data in cache
   */
  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    // Cleanup old cache entries (keep last 1000)
    if (this.cache.size > 1000) {
      const keys = Array.from(this.cache.keys());
      const oldestKeys = keys.slice(0, keys.length - 1000);
      oldestKeys.forEach(k => this.cache.delete(k));
    }
  }

  /**
   * Handle 429 errors with BingX-specific 10-minute recovery
   */
  async handleRateLimit(error: any, _attempt: number = 1): Promise<void> {
    if (error.response?.status === 429 || error.response?.data?.code === 109400) {
      // BingX rate limit: 10-minute automatic recovery
      const BINGX_RATE_LIMIT_RECOVERY_MS = 10 * 60 * 1000; // 10 minutes
      
      this.isRateLimited = true;
      this.rateLimitRecoveryTime = Date.now() + BINGX_RATE_LIMIT_RECOVERY_MS;
      
      const retryAfter = error.response.headers['retry-after'];
      const customDelay = retryAfter ? parseInt(retryAfter) * 1000 : BINGX_RATE_LIMIT_RECOVERY_MS;
      
      logger.error(`🚨 BingX RATE LIMIT HIT - Entering 10-minute recovery period`, {
        recoveryTime: new Date(this.rateLimitRecoveryTime).toISOString(),
        waitTimeMinutes: Math.ceil(customDelay / 60000),
        errorCode: error.response?.data?.code,
        errorMessage: error.response?.data?.msg
      });

      // Schedule automatic recovery
      if (this.recoveryTimeoutId) {
        clearTimeout(this.recoveryTimeoutId);
      }
      
      this.recoveryTimeoutId = setTimeout(() => {
        this.recoverFromRateLimit();
      }, customDelay);

      // Don't stop limiters - just wait and let the recovery handle it
      await new Promise(resolve => setTimeout(resolve, Math.min(customDelay, 30000))); // Max 30s wait per call
      
      // Throw error to stop current operations during rate limit period
      throw new Error(`BingX rate limit active. Recovery at ${new Date(this.rateLimitRecoveryTime).toISOString()}`);
    }
  }

  /**
   * Recover from BingX rate limit after 10-minute period
   */
  private recoverFromRateLimit(): void {
    logger.info('🎉 BingX rate limit recovery period completed - resuming operations');
    
    this.isRateLimited = false;
    this.rateLimitRecoveryTime = 0;
    this.recoveryTimeoutId = null;
    
    // Recreate limiters with fresh state
    this.restartLimiters();
    
    // Clear cache to ensure fresh data after recovery
    this.clearCache();
    
    logger.info('✅ Rate limiter fully recovered and operational');
  }

  /**
   * Get current limiter status for monitoring
   */
  getStatus() {
    const remainingTime = this.isRateLimited ? this.rateLimitRecoveryTime - Date.now() : 0;
    
    return {
      marketData: {
        running: this.marketDataLimiter.running(),
        queued: this.marketDataLimiter.queued(),
        reservoir: (this.marketDataLimiter as any).reservoir || 0
      },
      trading: {
        running: this.tradingLimiter.running(),
        queued: this.tradingLimiter.queued(),
        reservoir: (this.tradingLimiter as any).reservoir || 0
      },
      circuitBreaker: this.circuitBreaker.getState(),
      cacheSize: this.cache.size,
      rateLimitStatus: {
        isRateLimited: this.isRateLimited,
        recoveryTime: this.isRateLimited ? new Date(this.rateLimitRecoveryTime).toISOString() : null,
        remainingMinutes: this.isRateLimited ? Math.ceil(remainingTime / 60000) : 0
      }
    };
  }

  /**
   * Clear cache manually
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('🗑️ Rate limiter cache cleared');
  }

  /**
   * Restart limiters if they have been stopped
   */
  restartLimiters(): void {
    try {
      // Check if limiters are stopped and recreate them if needed
      if ((this.marketDataLimiter as any)._drainHandlers?.length === 0) {
        logger.warn('🔄 Market data limiter appears stopped, recreating...');
        this.marketDataLimiter = new Bottleneck({
          maxConcurrent: 3,
          minTime: 80,
          reservoir: 90,
          reservoirRefreshAmount: 90,
          reservoirRefreshInterval: 10 * 1000,
          id: 'bingx-market-data-optimized-restart'
        });
      }

      if ((this.tradingLimiter as any)._drainHandlers?.length === 0) {
        logger.warn('🔄 Trading limiter appears stopped, recreating...');
        this.tradingLimiter = new Bottleneck({
          maxConcurrent: 1,
          minTime: 250,
          reservoir: 4,
          reservoirRefreshAmount: 4,
          reservoirRefreshInterval: 1000,
          id: 'bingx-trading-restart'
        });
      }

      this.setupErrorHandling();
      logger.info('✅ Rate limiters restarted successfully');
    } catch (error) {
      logger.error('❌ Failed to restart limiters:', error);
    }
  }
}

interface CacheEntry {
  data: any;
  timestamp: number;
}

/**
 * Circuit Breaker for handling persistent API failures
 */
class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private failureThreshold = 5;
  private timeout = 60000; // 60 seconds
  private nextAttempt = 0;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN - API temporarily unavailable');
      }
      this.state = 'HALF_OPEN';
      logger.info('🔄 Circuit breaker moving to HALF_OPEN state');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      logger.info('✅ Circuit breaker CLOSED - API recovered');
    }
  }

  private onFailure(error: any): void {
    this.failureCount++;
    
    if (error.response?.status === 429 || error.response?.status >= 500) {
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN';
        this.nextAttempt = Date.now() + this.timeout;
        logger.error(`🚨 Circuit breaker OPEN - API failures: ${this.failureCount}`);
      }
    }
  }

  getState(): string {
    return this.state;
  }
}

// Singleton instance
export const bingxRateLimiter = new BingXRateLimiter();