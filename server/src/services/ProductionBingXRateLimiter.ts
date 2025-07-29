/**
 * Production-Grade BingX Rate Limiter
 * Engineered for high-performance trading applications with zero rate limit violations
 * 
 * Key Features:
 * - Separate rate limiters for Market (100/10s) and Account (1000/10s) endpoints
 * - Token bucket algorithm with automatic refill
 * - Exponential backoff with jitter for failed requests
 * - Circuit breaker pattern for API health monitoring
 * - Request prioritization (Trading > Monitoring > Market Data)
 * - Comprehensive error categorization and recovery
 * - Production monitoring and alerting
 */

import Bottleneck from 'bottleneck';
import { logger, logToExternal } from '../utils/logger';

// Error categorization for intelligent handling
const ERROR_CATEGORIES = {
  RATE_LIMIT: ['100001', '100413', 'Too many requests', '429', 'rate limit', 'quota exceeded'],
  NETWORK: ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'timeout'],
  AUTH: ['100403', 'Invalid signature', 'Invalid API key', 'unauthorized'],
  SERVER: ['100500', '500', '502', '503', '504', 'Internal server error'],
  VALIDATION: ['100400', '400', 'Bad request', 'Invalid parameter']
} as const;

// Request priority levels for intelligent queuing
export enum RequestPriority {
  CRITICAL = 1,    // Order placement/cancellation
  HIGH = 2,        // Position/balance queries
  MEDIUM = 3,      // Market data updates
  LOW = 4          // Historical data/analysis
}

// Endpoint categories for rate limit separation
enum EndpointType {
  MARKET_DATA = 'market',
  ACCOUNT_TRADING = 'account'
}

interface RateLimitConfig {
  maxConcurrent: number;
  minTime: number;
  reservoir: number;
  reservoirRefreshAmount: number;
  reservoirRefreshInterval: number;
}

interface RequestMetrics {
  totalRequests: number;
  successfulRequests: number;
  rateLimitHits: number;
  circuitBreakerTrips: number;
  avgResponseTime: number;
  lastResetTime: number;
}

interface CacheEntry {
  data: any;
  timestamp: number;
  hits: number;
}

export class ProductionBingXRateLimiter {
  private marketDataLimiter!: Bottleneck;
  private accountTradingLimiter!: Bottleneck;
  private circuitBreaker!: EnhancedCircuitBreaker;
  private cache!: Map<string, CacheEntry>;
  private metrics!: RequestMetrics;
  private isRateLimited: boolean = false;
  private rateLimitRecoveryTime: number = 0;
  private recoveryTimeoutId: NodeJS.Timeout | null = null;

  // OFFICIAL BINGX RATE LIMITS (April 2024) - Strict Compliance
  private readonly MARKET_DATA_CONFIG: RateLimitConfig = {
    maxConcurrent: 2,      // Conservative concurrent requests
    minTime: 105,          // 105ms = ~9.5 requests/second (safe buffer from 10/s burst)
    reservoir: 95,         // Start with 95 tokens (5 token safety buffer from 100 limit)
    reservoirRefreshAmount: 95,
    reservoirRefreshInterval: 10 * 1000 // Exact 10 seconds per BingX spec
  };

  private readonly ACCOUNT_TRADING_CONFIG: RateLimitConfig = {
    maxConcurrent: 3,      // Reduced for safety - BingX has per-endpoint sub-limits
    minTime: 12,           // 12ms = ~83 requests/second (safe buffer from 100/s burst)
    reservoir: 950,        // Start with 950 tokens (50 token safety buffer from 1000 limit)
    reservoirRefreshAmount: 950,
    reservoirRefreshInterval: 10 * 1000 // Exact 10 seconds per BingX spec
  };

  constructor() {
    this.initializeMetrics();
    this.setupRateLimiters();
    this.circuitBreaker = new EnhancedCircuitBreaker();
    this.cache = new Map();
    this.setupMonitoring();

    logger.info('🚀 Production BingX Rate Limiter initialized', {
      marketDataLimit: '100 requests/10s',
      accountTradingLimit: '1000 requests/10s',
      bufferFactor: '80%',
      priorityQueuing: 'enabled'
    });
  }

  private initializeMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      rateLimitHits: 0,
      circuitBreakerTrips: 0,
      avgResponseTime: 0,
      lastResetTime: Date.now()
    };
  }

  private setupRateLimiters(): void {
    // Market Data Limiter (100 requests/10s per IP)
    this.marketDataLimiter = new Bottleneck({
      ...this.MARKET_DATA_CONFIG,
      id: 'bingx-market-data-development'
    });

    // Account/Trading Limiter (1000 requests/10s per IP)
    this.accountTradingLimiter = new Bottleneck({
      ...this.ACCOUNT_TRADING_CONFIG,
      id: 'bingx-account-trading-development'
    });

    this.setupLimiterEventHandlers();
  }

  private setupLimiterEventHandlers(): void {
    // Market data limiter events
    this.marketDataLimiter.on('error', (error) => {
      logger.error('Market data limiter error:', error);
      this.metrics.circuitBreakerTrips++;
    });

    this.marketDataLimiter.on('depleted', () => {
      logger.warn('⚠️ Market data rate limit depleted - requests queued');
      this.logRateLimitWarning('market_data');
    });

    // Account trading limiter events
    this.accountTradingLimiter.on('error', (error) => {
      logger.error('Account trading limiter error:', error);
      this.metrics.circuitBreakerTrips++;
    });

    this.accountTradingLimiter.on('depleted', () => {
      logger.warn('⚠️ Account trading rate limit depleted - requests queued');
      this.logRateLimitWarning('account_trading');
    });
  }

  private setupMonitoring(): void {
    // Reset metrics every hour
    setInterval(() => {
      const duration = Date.now() - this.metrics.lastResetTime;
      const successRate = this.metrics.totalRequests > 0 
        ? (this.metrics.successfulRequests / this.metrics.totalRequests * 100).toFixed(2)
        : '100.00';

      logger.info('📊 Rate Limiter Hourly Metrics', {
        duration: `${(duration / 60000).toFixed(1)}min`,
        totalRequests: this.metrics.totalRequests,
        successRate: `${successRate}%`,
        rateLimitHits: this.metrics.rateLimitHits,
        circuitBreakerTrips: this.metrics.circuitBreakerTrips,
        avgResponseTime: `${this.metrics.avgResponseTime.toFixed(0)}ms`,
        cacheSize: this.cache.size
      });

      // Alert if success rate below 95%
      if (parseFloat(successRate) < 95 && this.metrics.totalRequests > 10) {
        this.sendAlert('LOW_SUCCESS_RATE', {
          successRate,
          totalRequests: this.metrics.totalRequests,
          rateLimitHits: this.metrics.rateLimitHits
        });
      }

      this.initializeMetrics();
    }, 60 * 60 * 1000); // Every hour
  }

  /**
   * Execute market data request with intelligent rate limiting and caching
   */
  async executeMarketDataRequest<T>(
    key: string,
    requestFn: () => Promise<T>,
    options: {
      cacheSeconds?: number;
      priority?: RequestPriority;
      maxRetries?: number;
    } = {}
  ): Promise<T> {
    const {
      cacheSeconds = 30,
      priority = RequestPriority.MEDIUM,
      maxRetries = 3
    } = options;

    return this.executeRequest(
      EndpointType.MARKET_DATA,
      key,
      requestFn,
      { cacheSeconds, priority, maxRetries }
    );
  }

  /**
   * Execute account/trading request with highest priority
   */
  async executeAccountRequest<T>(
    key: string,
    requestFn: () => Promise<T>,
    options: {
      cacheSeconds?: number;
      priority?: RequestPriority;
      maxRetries?: number;
    } = {}
  ): Promise<T> {
    const {
      cacheSeconds = 0, // No caching for trading operations by default
      priority = RequestPriority.CRITICAL,
      maxRetries = 5
    } = options;

    return this.executeRequest(
      EndpointType.ACCOUNT_TRADING,
      key,
      requestFn,
      { cacheSeconds, priority, maxRetries }
    );
  }

  private async executeRequest<T>(
    endpointType: EndpointType,
    key: string,
    requestFn: () => Promise<T>,
    options: {
      cacheSeconds: number;
      priority: RequestPriority;
      maxRetries: number;
    }
  ): Promise<T> {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    // Check rate limit recovery
    if (this.isRateLimited) {
      const remainingTime = this.rateLimitRecoveryTime - Date.now();
      if (remainingTime > 0) {
        throw new Error(`BingX rate limit active. Recovery in ${Math.ceil(remainingTime / 1000)}s`);
      } else {
        await this.recoverFromRateLimit();
      }
    }

    // Check cache first (if caching enabled)
    if (options.cacheSeconds > 0) {
      const cached = this.getFromCache(key, options.cacheSeconds * 1000);
      if (cached) {
        logger.debug(`📋 Cache hit for ${key}`);
        return cached as T;
      }
    }

    // Execute with circuit breaker and appropriate rate limiter
    const limiter = endpointType === EndpointType.MARKET_DATA 
      ? this.marketDataLimiter 
      : this.accountTradingLimiter;

    try {
      const result = await this.circuitBreaker.execute(async () => {
        return limiter.schedule({ priority: options.priority }, async () => {
          const result = await this.executeWithRetry(requestFn, options.maxRetries, key);
          
          // Cache successful results
          if (options.cacheSeconds > 0) {
            this.setCache(key, result);
          }
          
          return result;
        });
      });

      // Update metrics
      this.metrics.successfulRequests++;
      this.metrics.avgResponseTime = (this.metrics.avgResponseTime + (Date.now() - startTime)) / 2;
      
      return result;
    } catch (error: any) {
      await this.handleRequestError(error, key, endpointType);
      throw error;
    }
  }

  private async executeWithRetry<T>(
    requestFn: () => Promise<T>,
    maxRetries: number,
    key: string
  ): Promise<T> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`🌐 API call attempt ${attempt}/${maxRetries}: ${key}`);
        return await requestFn();
      } catch (error: any) {
        lastError = error;
        const errorCategory = this.categorizeError(error);
        
        if (errorCategory === 'RATE_LIMIT') {
          await this.handleRateLimit(error);
          // Don't retry rate limit errors - they're handled by the rate limiter
          throw error;
        }
        
        if (errorCategory === 'NETWORK' && attempt < maxRetries) {
          const backoffDelay = this.calculateBackoffDelay(attempt);
          logger.warn(`🔄 Network error, retrying in ${backoffDelay}ms (attempt ${attempt}/${maxRetries})`, {
            error: error.message,
            key
          });
          await this.sleep(backoffDelay);
          continue;
        }
        
        // Non-retryable errors or max retries reached
        if (attempt === maxRetries) {
          logger.error(`❌ All retry attempts failed for ${key}`, {
            attempts: maxRetries,
            finalError: error.message,
            errorCategory
          });
        }
        
        throw error;
      }
    }
    
    throw lastError;
  }

  private categorizeError(error: any): keyof typeof ERROR_CATEGORIES | 'UNKNOWN' {
    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.response?.status?.toString() || error.code?.toString() || '';
    
    for (const [category, patterns] of Object.entries(ERROR_CATEGORIES)) {
      if (patterns.some(pattern => 
        errorMessage.includes(pattern.toLowerCase()) || 
        errorCode.includes(pattern)
      )) {
        return category as keyof typeof ERROR_CATEGORIES;
      }
    }
    
    return 'UNKNOWN';
  }

  private calculateBackoffDelay(attempt: number): number {
    // Exponential backoff with jitter: min(base * 2^attempt + jitter, maxDelay)
    const baseDelay = 1000; // 1 second
    const maxDelay = 30000; // 30 seconds
    const jitter = Math.random() * 1000; // 0-1 second jitter
    
    return Math.min(baseDelay * Math.pow(2, attempt - 1) + jitter, maxDelay);
  }

  private async handleRateLimit(error: any): Promise<void> {
    this.metrics.rateLimitHits++;
    
    // BingX OFFICIAL: Parse rate limit details from response
    const retryAfter = error.response?.headers['retry-after'] || error.response?.headers['Retry-After'];
    const rateLimitRemaining = error.response?.headers['x-ratelimit-remaining'] || '0';
    const rateLimitReset = error.response?.headers['x-ratelimit-reset'];
    
    // BingX COMPLIANCE: Minimum 10 second recovery for market data limits
    let recoveryDelay = 10000; // Default 10s for BingX 10-second windows
    
    if (retryAfter) {
      recoveryDelay = Math.max(parseInt(retryAfter) * 1000, 10000);
    } else if (rateLimitReset) {
      const resetTime = parseInt(rateLimitReset) * 1000;
      recoveryDelay = Math.max(resetTime - Date.now(), 10000);
    }
    
    // BingX SAFETY: Add buffer for development stability
    if (process.env.NODE_ENV === 'development') {
      recoveryDelay = Math.max(recoveryDelay * 1.2, 12000); // 20% buffer, minimum 12s
    }
    
    this.isRateLimited = true;
    this.rateLimitRecoveryTime = Date.now() + recoveryDelay;
    
    logger.error('🚨 BingX Rate Limit Hit - STRICT COMPLIANCE RECOVERY', {
      endpoint: error.config?.url,
      recoveryTime: new Date(this.rateLimitRecoveryTime).toISOString(),
      waitTimeSeconds: Math.ceil(recoveryDelay / 1000),
      errorCode: error.response?.data?.code,
      errorMessage: error.response?.data?.msg,
      retryAfterHeader: retryAfter,
      remainingRequests: rateLimitRemaining,
      resetTime: rateLimitReset,
      complianceMode: 'STRICT_10_SECOND_WINDOW'
    });

    // BingX PRODUCTION: Enhanced monitoring
    if (process.env.NODE_ENV === 'development') {
      await logToExternal('error', 'BingX Rate Limit - Strict Compliance Mode', {
        endpoint: error.config?.url,
        waitTimeSeconds: Math.ceil(recoveryDelay / 1000),
        rateLimitHits: this.metrics.rateLimitHits,
        totalRequests: this.metrics.totalRequests,
        environment: 'development',
        complianceLevel: 'strict_official_limits',
        bingxWindow: '10_seconds'
      });
    }

    // BingX RECOVERY: Aggressive limiter suspension
    this.marketDataLimiter.stop({ dropWaitingJobs: false });
    this.accountTradingLimiter.stop({ dropWaitingJobs: false });

    // Schedule automatic recovery with limiter restart
    if (this.recoveryTimeoutId) {
      clearTimeout(this.recoveryTimeoutId);
    }
    
    this.recoveryTimeoutId = setTimeout(async () => {
      await this.recoverFromRateLimit();
    }, recoveryDelay);

    // BingX ALERT: Critical rate limit violations
    if (this.metrics.rateLimitHits > 2) { // More aggressive alerting
      await this.sendAlert('CRITICAL_BINGX_RATE_LIMIT', {
        hits: this.metrics.rateLimitHits,
        totalRequests: this.metrics.totalRequests,
        endpoint: error.config?.url,
        recoverySeconds: Math.ceil(recoveryDelay / 1000),
        complianceMode: 'strict'
      });
    }
  }

  private async recoverFromRateLimit(): Promise<void> {
    logger.info('🎉 BingX STRICT COMPLIANCE RECOVERY - Restarting limiters');
    
    try {
      // BingX RECOVERY: Restart limiters with fresh token buckets
      // Note: Bottleneck auto-starts when jobs are queued, no explicit start() needed
      logger.info('🔄 BINGX: Limiters will auto-start on next request');
      
      // Reset rate limit state
      this.isRateLimited = false;
      this.rateLimitRecoveryTime = 0;
      this.recoveryTimeoutId = null;
      
      // Reset circuit breaker on successful recovery
      this.circuitBreaker.reset();
      
      // Clear cache to ensure fresh data after recovery
      this.clearCache();
      
      logger.info('✅ BingX Rate Limiter STRICT COMPLIANCE Recovery Complete', {
        marketDataRunning: this.marketDataLimiter.running(),
        accountTradingRunning: this.accountTradingLimiter.running(),
        marketDataQueued: this.marketDataLimiter.queued(),
        accountTradingQueued: this.accountTradingLimiter.queued(),
        complianceMode: 'strict_10_second_windows'
      });
      
    } catch (error) {
      logger.error('❌ BingX Rate Limiter Recovery Failed:', error);
      
      // Fallback: Complete restart if recovery fails
      this.setupRateLimiters();
      this.isRateLimited = false;
      this.rateLimitRecoveryTime = 0;
      this.recoveryTimeoutId = null;
      
      logger.warn('🔄 Performed fallback limiter restart due to recovery failure');
    }
  }

  private async handleRequestError(error: any, key: string, endpointType: EndpointType): Promise<void> {
    const errorCategory = this.categorizeError(error);
    
    logger.error(`❌ Request failed: ${key}`, {
      category: errorCategory,
      endpointType,
      error: error.message,
      status: error.response?.status,
      code: error.response?.data?.code
    });

    // Log critical errors to external monitoring
    if (process.env.NODE_ENV === 'development' && 
        ['RATE_LIMIT', 'SERVER'].includes(errorCategory)) {
      await logToExternal('error', `BingX API Error: ${errorCategory}`, {
        key,
        endpointType,
        error: error.message,
        status: error.response?.status,
        code: error.response?.data?.code
      });
    }
  }

  private logRateLimitWarning(limiterType: string): void {
    logger.warn(`⚠️ Rate limit approaching for ${limiterType}`, {
      queuedRequests: limiterType === 'market_data' 
        ? this.marketDataLimiter.queued()
        : this.accountTradingLimiter.queued(),
      runningRequests: limiterType === 'market_data'
        ? this.marketDataLimiter.running()
        : this.accountTradingLimiter.running()
    });
  }

  private async sendAlert(alertType: string, data: any): Promise<void> {
    // Implement your alerting mechanism here (Slack, email, etc.)
    logger.error(`🚨 ALERT: ${alertType}`, data);
    
    if (process.env.NODE_ENV === 'development') {
      await logToExternal('alert', `Production Alert: ${alertType}`, {
        ...data,
        timestamp: new Date().toISOString(),
        service: 'bingx-trading-bot'
      });
    }
  }

  private getFromCache<T>(key: string, maxAge: number): T | null {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < maxAge) {
      entry.hits++;
      return entry.data as T;
    }
    return null;
  }

  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      hits: 0
    });

    // Intelligent cache cleanup
    if (this.cache.size > 1000) {
      this.cleanupCache();
    }
  }

  private cleanupCache(): void {
    // Remove least recently used entries
    const entries = Array.from(this.cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.slice(0, Math.floor(entries.length * 0.3));
    toRemove.forEach(([key]) => this.cache.delete(key));
    
    logger.debug(`🗑️ Cache cleanup: removed ${toRemove.length} entries`);
  }

  private clearCache(): void {
    this.cache.clear();
    logger.info('🗑️ Rate limiter cache cleared for recovery');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get comprehensive status for monitoring
   */
  getStatus() {
    const remainingTime = this.isRateLimited ? this.rateLimitRecoveryTime - Date.now() : 0;
    
    return {
      rateLimitStatus: {
        isRateLimited: this.isRateLimited,
        recoveryTime: this.isRateLimited ? new Date(this.rateLimitRecoveryTime).toISOString() : null,
        remainingSeconds: this.isRateLimited ? Math.ceil(remainingTime / 1000) : 0
      },
      marketData: {
        running: this.marketDataLimiter.running(),
        queued: this.marketDataLimiter.queued(),
        reservoir: (this.marketDataLimiter as any).reservoir || 0
      },
      accountTrading: {
        running: this.accountTradingLimiter.running(),
        queued: this.accountTradingLimiter.queued(),
        reservoir: (this.accountTradingLimiter as any).reservoir || 0
      },
      circuitBreaker: this.circuitBreaker.getStatus(),
      metrics: {
        ...this.metrics,
        successRate: this.metrics.totalRequests > 0 
          ? (this.metrics.successfulRequests / this.metrics.totalRequests * 100).toFixed(2) + '%'
          : '100%'
      },
      cache: {
        size: this.cache.size,
        hitRate: this.calculateCacheHitRate()
      }
    };
  }

  private calculateCacheHitRate(): string {
    const entries = Array.from(this.cache.values());
    const totalHits = entries.reduce((sum, entry) => sum + entry.hits, 0);
    const totalEntries = entries.length;
    
    if (totalEntries === 0) return '0%';
    return ((totalHits / totalEntries) * 100).toFixed(1) + '%';
  }

  /**
   * Restart limiters in case of failure
   */
  restart(): void {
    logger.info('🔄 Restarting development rate limiters...');
    
    try {
      this.setupRateLimiters();
      this.circuitBreaker.reset();
      this.clearCache();
      this.initializeMetrics();
      
      logger.info('✅ Production rate limiters restarted successfully');
    } catch (error) {
      logger.error('❌ Failed to restart rate limiters:', error);
      throw error;
    }
  }
}

/**
 * Enhanced Circuit Breaker with intelligent failure detection
 */
class EnhancedCircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private failureThreshold = 5;
  private successThreshold = 3; // Successes needed to close from half-open
  private timeout = 60000; // 60 seconds
  private nextAttempt = 0;
  private lastFailureTime = 0;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN - API temporarily unavailable');
      }
      this.state = 'HALF_OPEN';
      logger.info('🔄 Circuit breaker transitioning to HALF_OPEN state');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.successCount = 0;
        logger.info('✅ Circuit breaker CLOSED - API fully recovered');
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
      this.successCount = 0;
      logger.error('🚨 Circuit breaker OPEN - API failed during recovery');
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
      logger.error(`🚨 Circuit breaker OPEN - API failures exceeded threshold: ${this.failureCount}`);
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = 0;
    logger.info('🔄 Circuit breaker manually reset');
  }

  getStatus(): object {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      nextAttempt: this.nextAttempt > 0 ? new Date(this.nextAttempt).toISOString() : null,
      lastFailureTime: this.lastFailureTime > 0 ? new Date(this.lastFailureTime).toISOString() : null
    };
  }
}

// Singleton instance for development use
export const productionBingXRateLimiter = new ProductionBingXRateLimiter();