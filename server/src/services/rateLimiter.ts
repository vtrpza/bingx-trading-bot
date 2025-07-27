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
  private readonly maxRequests: number = 3; // Conservative: 3 requests per 1000ms (instead of 5/900ms)
  private readonly windowMs: number = 1000; // 1 second window for better spacing
  private requestQueue: Array<{resolve: () => void, reject: (error: Error) => void}> = [];
  private isProcessingQueue: boolean = false;

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
   * Queue-based request waiting system to prevent API overload
   * @returns Promise that resolves when a request can be made
   */
  async waitForSlot(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Add to queue
      this.requestQueue.push({ resolve, reject });
      
      // Start processing if not already running
      if (!this.isProcessingQueue) {
        this.processQueue();
      }
    });
  }

  /**
   * Process the request queue sequentially with proper spacing
   */
  private async processQueue(): Promise<void> {
    this.isProcessingQueue = true;
    
    while (this.requestQueue.length > 0) {
      const { resolve, reject } = this.requestQueue.shift()!;
      
      try {
        // Wait for available slot
        await this.waitForAvailableSlot();
        
        // Resolve the waiting request
        resolve();
        
        // Add minimum spacing between requests (350ms)
        await new Promise(r => setTimeout(r, 350));
        
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Rate limit error'));
      }
    }
    
    this.isProcessingQueue = false;
  }

  /**
   * Internal method to wait for an available request slot
   */
  private async waitForAvailableSlot(): Promise<void> {
    let retryCount = 0;
    const maxRetries = 15;
    
    while (!this.canMakeRequest() && retryCount < maxRetries) {
      const now = Date.now();
      const oldestRequest = this.requestLog[0];
      const timeUntilReset = this.windowMs - (now - oldestRequest) + 100;
      
      const waitTime = Math.max(timeUntilReset, 400); // Minimum 400ms wait
      
      logger.debug(`Waiting for rate limit slot: ${waitTime}ms (attempt ${retryCount + 1}/${maxRetries})`);
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
      queuedRequests: this.requestQueue.length,
      isProcessingQueue: this.isProcessingQueue,
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