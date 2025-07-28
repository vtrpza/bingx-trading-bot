import { logger } from '../utils/logger';

/**
 * Request categories for intelligent rate limiting
 */
export enum RequestCategory {
  MARKET_DATA = 'market_data',    // getTicker, getKlines, getDepth - 25 req/s
  TRADING = 'trading',            // Orders, positions - 15 req/s  
  ACCOUNT = 'account',            // Balance, account info - 10 req/s
  SYMBOLS = 'symbols'             // Symbol lists - uses MARKET_DATA limits
}

/**
 * A generic rate limiter class.
 */
export class RateLimiter {
  private requestLog: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  canMakeRequest(): boolean {
    const now = Date.now();
    this.requestLog = this.requestLog.filter(timestamp => now - timestamp < this.windowMs);

    if (this.requestLog.length >= this.maxRequests) {
      const oldestRequest = this.requestLog[0];
      const timeUntilReset = this.windowMs - (now - oldestRequest);
      logger.warn('Rate limit exceeded', {
        currentRequests: this.requestLog.length,
        maxRequests: this.maxRequests,
        timeUntilReset: Math.ceil(timeUntilReset / 1000)
      });
      return false;
    }

    this.requestLog.push(now);
    logger.debug('Rate limit check passed', {
      currentRequests: this.requestLog.length,
      maxRequests: this.maxRequests,
      remainingRequests: this.maxRequests - this.requestLog.length
    });
    return true;
  }

  async waitForSlot(): Promise<void> {
    let retryCount = 0;
    const maxRetries = 10;

    while (!this.canMakeRequest() && retryCount < maxRetries) {
      const now = Date.now();
      const oldestRequest = this.requestLog[0];
      const baseWaitTime = this.windowMs - (now - oldestRequest) + 300;
      const waitTime = Math.max(300, baseWaitTime * Math.pow(1.2, retryCount));
      logger.info(`Rate limited - waiting ${waitTime}ms (attempt ${retryCount + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      retryCount++;
    }

    if (retryCount >= maxRetries) {
      logger.error('Rate limit exceeded - max retries reached.');
      throw new Error('Rate limit exceeded - max retries reached');
    }
  }

  getStatus() {
    const now = Date.now();
    this.requestLog = this.requestLog.filter(timestamp => now - timestamp < this.windowMs);
    return {
      currentRequests: this.requestLog.length,
      maxRequests: this.maxRequests,
      remainingRequests: this.maxRequests - this.requestLog.length,
      windowMs: this.windowMs,
      oldestRequestAge: this.requestLog.length > 0 ? now - this.requestLog[0] : 0
    };
  }

  reset(): void {
    this.requestLog = [];
    logger.info('Rate limiter reset');
  }
}

/**
 * 🚀 ULTRA-PERFORMANCE Global rate limiter for BingX API calls
 * Uses REAL BingX limits with intelligent categorization
 * Market Data: 25 req/s | Trading: 15 req/s | Account: 10 req/s
 * Burst Mode: 50 requests in 10 seconds for initialization
 */
export class GlobalRateLimiter {
  private marketDataLog: number[] = [];
  private tradingLog: number[] = [];
  private accountLog: number[] = [];
  private burstLog: number[] = [];
  
  // REAL BingX LIMITS (aggressive but safe)
  private readonly marketDataLimit: number = 25; // 25 req/s for market data
  private readonly tradingLimit: number = 15; // 15 req/s for trading operations
  private readonly accountLimit: number = 10; // 10 req/s for account operations
  private readonly burstLimit: number = 50; // 50 requests in 10 seconds
  private readonly windowMs: number = 1000; // 1 second window
  private readonly burstWindowMs: number = 10000; // 10 second burst window
  
  private requestQueue: Array<{
    resolve: () => void, 
    reject: (error: Error) => void,
    category: RequestCategory
  }> = [];
  private isProcessingQueue: boolean = false;

  /**
   * 🚀 ULTRA-FAST Check if a request can be made within categorized rate limits
   * @param category Request category (MARKET_DATA, TRADING, ACCOUNT)
   * @returns true if request is allowed, false if rate limited
   */
  canMakeRequest(category: RequestCategory = RequestCategory.MARKET_DATA): boolean {
    const now = Date.now();
    
    // Get appropriate log and limit for category
    const { log, limit } = this.getCategoryConfig(category);
    
    // Clean old requests for this category
    const filtered = log.filter(timestamp => now - timestamp < this.windowMs);
    this.setCategoryLog(category, filtered);
    
    // Clean burst log
    this.burstLog = this.burstLog.filter(timestamp => now - timestamp < this.burstWindowMs);
    
    // Check burst limit first (global limit)
    if (this.burstLog.length >= this.burstLimit) {
      logger.warn('🚨 Burst rate limit exceeded', {
        burstRequests: this.burstLog.length,
        burstLimit: this.burstLimit,
        category
      });
      return false;
    }
    
    // Check category-specific limit
    if (filtered.length >= limit) {
      const oldestRequest = filtered[0];
      const timeUntilReset = this.windowMs - (now - oldestRequest);
      
      logger.warn('⚠️ Category rate limit exceeded', {
        category,
        currentRequests: filtered.length,
        maxRequests: limit,
        timeUntilReset: Math.ceil(timeUntilReset / 1000)
      });
      
      return false;
    }
    
    // Record this request in both category and burst logs
    filtered.push(now);
    this.burstLog.push(now);
    this.setCategoryLog(category, filtered);
    
    logger.debug(`⚡ Rate limit passed [${category}]`, {
      categoryRequests: filtered.length,
      categoryLimit: limit,
      burstRequests: this.burstLog.length,
      burstLimit: this.burstLimit,
      remaining: limit - filtered.length
    });
    
    return true;
  }

  /**
   * Helper to get log and limit for category
   */
  private getCategoryConfig(category: RequestCategory): { log: number[], limit: number } {
    switch (category) {
      case RequestCategory.MARKET_DATA:
      case RequestCategory.SYMBOLS:
        return { log: this.marketDataLog, limit: this.marketDataLimit };
      case RequestCategory.TRADING:
        return { log: this.tradingLog, limit: this.tradingLimit };
      case RequestCategory.ACCOUNT:
        return { log: this.accountLog, limit: this.accountLimit };
      default:
        return { log: this.marketDataLog, limit: this.marketDataLimit };
    }
  }

  /**
   * Helper to set log for category
   */
  private setCategoryLog(category: RequestCategory, log: number[]): void {
    switch (category) {
      case RequestCategory.MARKET_DATA:
      case RequestCategory.SYMBOLS:
        this.marketDataLog = log;
        break;
      case RequestCategory.TRADING:
        this.tradingLog = log;
        break;
      case RequestCategory.ACCOUNT:
        this.accountLog = log;
        break;
    }
  }

  /**
   * 🚀 ULTRA-FAST Queue-based request waiting system with category support
   * @param category Request category for appropriate rate limiting
   * @returns Promise that resolves when a request can be made
   */
  async waitForSlot(category: RequestCategory = RequestCategory.MARKET_DATA): Promise<void> {
    return new Promise((resolve, reject) => {
      // Add to queue with category
      this.requestQueue.push({ resolve, reject, category });
      
      // Start processing if not already running
      if (!this.isProcessingQueue) {
        this.processQueue();
      }
    });
  }

  /**
   * 🚀 ULTRA-FAST Process the request queue with intelligent spacing
   */
  private async processQueue(): Promise<void> {
    this.isProcessingQueue = true;
    
    while (this.requestQueue.length > 0) {
      const { resolve, reject, category } = this.requestQueue.shift()!;
      
      try {
        // Wait for available slot for this category
        await this.waitForAvailableSlot(category);
        
        // Resolve the waiting request
        resolve();
        
        // AGGRESSIVE SPACING: Minimal delay for ultra performance
        const spacing = this.getOptimalSpacing(category);
        if (spacing > 0) {
          await new Promise(r => setTimeout(r, spacing));
        }
        
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Rate limit error'));
      }
    }
    
    this.isProcessingQueue = false;
  }

  /**
   * Get optimal spacing between requests based on category
   */
  private getOptimalSpacing(category: RequestCategory): number {
    switch (category) {
      case RequestCategory.MARKET_DATA:
      case RequestCategory.SYMBOLS:
        return 20; // 20ms = ultra fast for market data (50 req/s potential)
      case RequestCategory.TRADING:
        return 50; // 50ms for trading (20 req/s)
      case RequestCategory.ACCOUNT:
        return 80; // 80ms for account (12.5 req/s)
      default:
        return 40; // Default spacing
    }
  }

  /**
   * 🚀 ULTRA-FAST Internal method to wait for an available request slot
   */
  private async waitForAvailableSlot(category: RequestCategory): Promise<void> {
    let retryCount = 0;
    const maxRetries = 20; // Increased retries for higher throughput
    
    while (!this.canMakeRequest(category) && retryCount < maxRetries) {
      const { log } = this.getCategoryConfig(category);
      const now = Date.now();
      
      let waitTime = 50; // Minimum ultra-fast wait
      
      if (log.length > 0) {
        const oldestRequest = log[0];
        const timeUntilReset = this.windowMs - (now - oldestRequest) + 10;
        waitTime = Math.max(timeUntilReset, 50); // Minimum 50ms wait
      }
      
      logger.debug(`⏳ Waiting for ${category} slot: ${waitTime}ms (${retryCount + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      retryCount++;
    }
    
    if (retryCount >= maxRetries) {
      logger.error(`💥 Rate limit exceeded for ${category} - max retries reached`);
      throw new Error(`Rate limit exceeded for ${category} - max retries reached`);
    }
  }

  /**
   * 📊 Get comprehensive rate limit status for all categories
   */
  getStatus() {
    const now = Date.now();
    
    // Clean old requests for all categories
    this.marketDataLog = this.marketDataLog.filter(t => now - t < this.windowMs);
    this.tradingLog = this.tradingLog.filter(t => now - t < this.windowMs);
    this.accountLog = this.accountLog.filter(t => now - t < this.windowMs);
    this.burstLog = this.burstLog.filter(t => now - t < this.burstWindowMs);
    
    return {
      marketData: {
        current: this.marketDataLog.length,
        max: this.marketDataLimit,
        remaining: this.marketDataLimit - this.marketDataLog.length,
        percentage: (this.marketDataLog.length / this.marketDataLimit * 100).toFixed(1)
      },
      trading: {
        current: this.tradingLog.length,
        max: this.tradingLimit,
        remaining: this.tradingLimit - this.tradingLog.length,
        percentage: (this.tradingLog.length / this.tradingLimit * 100).toFixed(1)
      },
      account: {
        current: this.accountLog.length,
        max: this.accountLimit,
        remaining: this.accountLimit - this.accountLog.length,
        percentage: (this.accountLog.length / this.accountLimit * 100).toFixed(1)
      },
      burst: {
        current: this.burstLog.length,
        max: this.burstLimit,
        remaining: this.burstLimit - this.burstLog.length,
        percentage: (this.burstLog.length / this.burstLimit * 100).toFixed(1)
      },
      queue: {
        pending: this.requestQueue.length,
        processing: this.isProcessingQueue,
        categories: this.getQueueCategoryBreakdown()
      },
      performance: {
        totalRequestsPerSecond: (this.marketDataLog.length + this.tradingLog.length + this.accountLog.length),
        efficiency: this.calculateEfficiency()
      }
    };
  }

  /**
   * Get breakdown of queue by category
   */
  private getQueueCategoryBreakdown() {
    const breakdown = {
      [RequestCategory.MARKET_DATA]: 0,
      [RequestCategory.TRADING]: 0,
      [RequestCategory.ACCOUNT]: 0,
      [RequestCategory.SYMBOLS]: 0
    };
    
    this.requestQueue.forEach(req => {
      breakdown[req.category]++;
    });
    
    return breakdown;
  }

  /**
   * Calculate current efficiency (0-100%)
   */
  private calculateEfficiency(): number {
    const totalUsed = this.marketDataLog.length + this.tradingLog.length + this.accountLog.length;
    const totalCapacity = this.marketDataLimit + this.tradingLimit + this.accountLimit;
    return totalCapacity > 0 ? (totalUsed / totalCapacity * 100) : 0;
  }

  /**
   * 🔄 Reset rate limiter (for testing)
   */
  reset(): void {
    this.marketDataLog = [];
    this.tradingLog = [];
    this.accountLog = [];
    this.burstLog = [];
    this.requestQueue = [];
    logger.info('🚀 ULTRA-PERFORMANCE Rate limiter reset - all categories cleared');
  }
}

// Global instance
export const globalRateLimiter = new GlobalRateLimiter();