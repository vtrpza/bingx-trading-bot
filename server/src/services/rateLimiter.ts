import { logger } from '../utils/logger';

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
 * Global rate limiter for BingX API calls
 * Enforces conservative rate limits to prevent 109400 errors
 * BingX limit: 5 requests per 900ms, implemented as 4 per 900ms (conservative approach)
 */
export class GlobalRateLimiter {
  private requestLog: number[] = [];
  private readonly maxRequests: number = 4; // Conservative: 4 requests per 900ms (BingX limit is 5)
  private readonly windowMs: number = 900; // BingX window: 900ms

  /**
   * Check if a request can be made within rate limits
   * @returns true if request is allowed, false if rate limited
   */
  canMakeRequest(): boolean {
    const now = Date.now();
    
    // Remove requests older than the window
    this.requestLog = this.requestLog.filter(timestamp => 
      now - timestamp < this.windowMs
    );
    
    // Check if we're at the limit
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
    
    // Record this request
    this.requestLog.push(now);
    
    logger.debug('Rate limit check passed', {
      currentRequests: this.requestLog.length,
      maxRequests: this.maxRequests,
      remainingRequests: this.maxRequests - this.requestLog.length
    });
    
    return true;
  }

  /**
   * Wait until next request slot is available with exponential backoff
   * @returns Promise that resolves when a request can be made
   */
  async waitForSlot(): Promise<void> {
    let retryCount = 0;
    const maxRetries = 10; // Increased retries for better reliability
    
    while (!this.canMakeRequest() && retryCount < maxRetries) {
      const now = Date.now();
      const oldestRequest = this.requestLog[0];
      const baseWaitTime = this.windowMs - (now - oldestRequest) + 300; // Increased buffer
      
      // Conservative backoff for BingX rate limits
      const waitTime = Math.max(300, baseWaitTime * Math.pow(1.2, retryCount));
      
      logger.info(`Rate limited - waiting ${waitTime}ms (attempt ${retryCount + 1}/${maxRetries}) to comply with BingX limits`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      retryCount++;
    }
    
    if (retryCount >= maxRetries) {
      logger.error('Rate limit exceeded - max retries reached. BingX API may be overloaded.');
      throw new Error('Rate limit exceeded - max retries reached');
    }
  }

  /**
   * Get current rate limit status
   */
  getStatus() {
    const now = Date.now();
    
    // Clean old requests
    this.requestLog = this.requestLog.filter(timestamp => 
      now - timestamp < this.windowMs
    );
    
    return {
      currentRequests: this.requestLog.length,
      maxRequests: this.maxRequests,
      remainingRequests: this.maxRequests - this.requestLog.length,
      windowMs: this.windowMs,
      oldestRequestAge: this.requestLog.length > 0 ? now - this.requestLog[0] : 0
    };
  }

  /**
   * Reset rate limiter (for testing)
   */
  reset(): void {
    this.requestLog = [];
    logger.info('Rate limiter reset');
  }
}

// Global instance
export const globalRateLimiter = new GlobalRateLimiter();