import { logger } from '../utils/logger';

/**
 * Global rate limiter for BingX API calls
 * Enforces conservative rate limits to prevent 109400 errors
 * BingX limit: 5 requests per 900ms, implemented as 8 per 1000ms (balanced approach)
 */
export class GlobalRateLimiter {
  private requestLog: number[] = [];
  private readonly maxRequests: number = 8; // Increased from 3 to 8 requests per second
  private readonly windowMs: number = 1000; // 1 second window

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
    const maxRetries = 5;
    
    while (!this.canMakeRequest() && retryCount < maxRetries) {
      const now = Date.now();
      const oldestRequest = this.requestLog[0];
      const baseWaitTime = this.windowMs - (now - oldestRequest) + 200; // Extra buffer
      
      // Exponential backoff: base delay * 2^retryCount
      const waitTime = Math.max(200, baseWaitTime * Math.pow(1.5, retryCount));
      
      logger.debug(`Rate limited - waiting ${waitTime}ms (attempt ${retryCount + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      retryCount++;
    }
    
    if (retryCount >= maxRetries) {
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