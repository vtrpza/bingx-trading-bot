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

  constructor() {
    // Market Data Limiter: 100 requests/10 seconds per IP (BingX official limit)
    this.marketDataLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 120, // 120ms between requests = ~8.3 requests/second (buffer for safety)
      reservoir: 90, // Start with 90 tokens (buffer from 100 limit)
      reservoirRefreshAmount: 90,
      reservoirRefreshInterval: 10 * 1000, // Refresh every 10 seconds
      id: 'bingx-market-data'
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
    this.marketDataLimiter.on('depleted', (empty) => {
      logger.warn('🚨 Market data rate limit depleted, requests will be queued');
    });

    this.tradingLimiter.on('depleted', (empty) => {
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
    // Check cache first
    const cached = this.getFromCache(key, cacheSeconds * 1000);
    if (cached) {
      logger.debug(`📋 Cache hit for ${key}`);
      return cached;
    }

    // Execute with circuit breaker and rate limiting
    return this.circuitBreaker.execute(async () => {
      return this.marketDataLimiter.schedule(async () => {
        logger.debug(`🌐 API call: ${key}`);
        const result = await requestFn();
        this.setCache(key, result);
        return result;
      });
    });
  }

  /**
   * Execute trading request with rate limiting
   */
  async executeTradingRequest<T>(
    requestFn: () => Promise<T>
  ): Promise<T> {
    return this.circuitBreaker.execute(async () => {
      return this.tradingLimiter.schedule(requestFn);
    });
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
   * Handle 429 errors with exponential backoff
   */
  async handleRateLimit(error: any, attempt: number = 1): Promise<void> {
    if (error.response?.status === 429) {
      const retryAfter = error.response.headers['retry-after'];
      const baseDelay = retryAfter ? parseInt(retryAfter) * 1000 : 10000;
      const jitteredDelay = baseDelay + Math.random() * 5000;
      const exponentialDelay = Math.min(jitteredDelay * Math.pow(2, attempt - 1), 60000);

      logger.warn(`🚦 Rate limited, waiting ${exponentialDelay}ms (attempt ${attempt})`);
      
      // Pause all limiters during cooldown
      this.marketDataLimiter.stop({ dropWaitingJobs: false });
      this.tradingLimiter.stop({ dropWaitingJobs: false });

      await new Promise(resolve => setTimeout(resolve, exponentialDelay));

      // Resume limiters
      this.marketDataLimiter.start();
      this.tradingLimiter.start();
    }
  }

  /**
   * Get current limiter status for monitoring
   */
  getStatus() {
    return {
      marketData: {
        running: this.marketDataLimiter.running(),
        queued: this.marketDataLimiter.queued(),
        reservoir: this.marketDataLimiter.reservoir()
      },
      trading: {
        running: this.tradingLimiter.running(),
        queued: this.tradingLimiter.queued(),
        reservoir: this.tradingLimiter.reservoir()
      },
      circuitBreaker: this.circuitBreaker.getState(),
      cacheSize: this.cache.size
    };
  }

  /**
   * Clear cache manually
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('🗑️ Rate limiter cache cleared');
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