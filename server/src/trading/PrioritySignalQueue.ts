import { EventEmitter } from 'events';
import { TradingSignal } from './signalGenerator';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface QueuedSignal {
  id: string;
  signal: TradingSignal;
  priority: number;
  queuedAt: number;
  expiresAt: number;
  processed: boolean;
  attempts: number;
  maxAttempts: number;
}

export interface SignalQueueConfig {
  maxSize: number;
  defaultTTL: number; // Time to live in milliseconds
  maxAttempts: number;
  deduplicationWindow: number; // Deduplication window in milliseconds
  priorityWeights: {
    strength: number;
    recency: number;
    volume: number;
  };
}

export interface QueueMetrics {
  totalQueued: number;
  totalProcessed: number;
  totalExpired: number;
  totalDuplicated: number;
  currentSize: number;
  averageWaitTime: number;
  throughput: number; // signals per minute
}

export class PrioritySignalQueue extends EventEmitter {
  private queue: QueuedSignal[] = [];
  private processed: Set<string> = new Set(); // Track processed signal hashes
  private config: SignalQueueConfig;
  private metrics: QueueMetrics;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private lastThroughputCheck: number = 0;
  private throughputCounter: number = 0;

  constructor(config: Partial<SignalQueueConfig> = {}) {
    super();
    
    this.config = {
      maxSize: 100,
      defaultTTL: 30000, // 30 seconds
      maxAttempts: 3,
      deduplicationWindow: 60000, // 1 minute
      priorityWeights: {
        strength: 0.6,
        recency: 0.3,
        volume: 0.1
      },
      ...config
    };

    this.metrics = {
      totalQueued: 0,
      totalProcessed: 0,
      totalExpired: 0,
      totalDuplicated: 0,
      currentSize: 0,
      averageWaitTime: 0,
      throughput: 0
    };

    this.startCleanupProcess();
    this.startThroughputTracking();
  }

  /**
   * Add a signal to the priority queue
   */
  enqueue(signal: TradingSignal, customTTL?: number): string | null {
    try {
      // Check if queue is full
      if (this.queue.length >= this.config.maxSize) {
        this.removeLowestPrioritySignal();
      }

      // Generate signal hash for deduplication
      const signalHash = this.generateSignalHash(signal);
      
      // Check for duplicates in recent window
      if (this.isDuplicate(signalHash)) {
        this.metrics.totalDuplicated++;
        logger.debug(`Duplicate signal detected for ${signal.symbol}, skipping`);
        return null;
      }

      // Calculate priority
      const priority = this.calculatePriority(signal);
      
      // Create queued signal
      const queuedSignal: QueuedSignal = {
        id: uuidv4(),
        signal,
        priority,
        queuedAt: Date.now(),
        expiresAt: Date.now() + (customTTL || this.config.defaultTTL),
        processed: false,
        attempts: 0,
        maxAttempts: this.config.maxAttempts
      };

      // Insert in priority order (higher priority first)
      this.insertByPriority(queuedSignal);
      
      // Track the signal hash
      this.processed.add(`${signalHash}:${Date.now()}`);
      
      // Update metrics
      this.metrics.totalQueued++;
      this.metrics.currentSize = this.queue.length;
      
      logger.debug(`Signal queued for ${signal.symbol}`, {
        id: queuedSignal.id,
        priority,
        strength: signal.strength,
        queueSize: this.queue.length
      });

      this.emit('signalQueued', queuedSignal);
      
      return queuedSignal.id;
      
    } catch (error) {
      logger.error('Error enqueueing signal:', error);
      return null;
    }
  }

  /**
   * Get the next signal to process (highest priority)
   */
  dequeue(): QueuedSignal | null {
    if (this.queue.length === 0) {
      return null;
    }

    // Find first unprocessed, non-expired signal
    for (let i = 0; i < this.queue.length; i++) {
      const queuedSignal = this.queue[i];
      
      if (!queuedSignal.processed && Date.now() < queuedSignal.expiresAt) {
        // Mark as processed
        queuedSignal.processed = true;
        queuedSignal.attempts++;
        
        // Update metrics
        this.metrics.totalProcessed++;
        this.throughputCounter++;
        
        const waitTime = Date.now() - queuedSignal.queuedAt;
        this.updateAverageWaitTime(waitTime);
        
        logger.debug(`Signal dequeued for ${queuedSignal.signal.symbol}`, {
          id: queuedSignal.id,
          waitTime,
          priority: queuedSignal.priority
        });

        this.emit('signalDequeued', queuedSignal);
        
        return queuedSignal;
      }
    }

    return null;
  }

  /**
   * Peek at the next signal without removing it
   */
  peek(): QueuedSignal | null {
    for (const queuedSignal of this.queue) {
      if (!queuedSignal.processed && Date.now() < queuedSignal.expiresAt) {
        return queuedSignal;
      }
    }
    return null;
  }

  /**
   * Mark a signal as failed and possibly requeue
   */
  markFailed(signalId: string, error: string): boolean {
    const index = this.queue.findIndex(qs => qs.id === signalId);
    
    if (index === -1) {
      return false;
    }

    const queuedSignal = this.queue[index];
    
    if (queuedSignal.attempts < queuedSignal.maxAttempts) {
      // Reset for retry
      queuedSignal.processed = false;
      queuedSignal.expiresAt = Date.now() + this.config.defaultTTL;
      
      // Move to end of queue for retry
      this.queue.splice(index, 1);
      this.queue.push(queuedSignal);
      
      logger.debug(`Signal ${signalId} marked for retry (attempt ${queuedSignal.attempts})`);
      
      this.emit('signalRetry', { queuedSignal, error });
      return true;
    } else {
      // Remove permanently failed signal
      this.queue.splice(index, 1);
      this.metrics.currentSize = this.queue.length;
      
      logger.warn(`Signal ${signalId} failed permanently after ${queuedSignal.attempts} attempts`);
      
      this.emit('signalFailed', { queuedSignal, error });
      return false;
    }
  }

  /**
   * Mark a signal as successfully completed
   */
  markCompleted(signalId: string): boolean {
    const index = this.queue.findIndex(qs => qs.id === signalId);
    
    if (index === -1) {
      return false;
    }

    const queuedSignal = this.queue.splice(index, 1)[0];
    this.metrics.currentSize = this.queue.length;
    
    logger.debug(`Signal ${signalId} completed successfully`);
    
    this.emit('signalCompleted', queuedSignal);
    return true;
  }

  /**
   * Get signals for a specific symbol
   */
  getSignalsForSymbol(symbol: string): QueuedSignal[] {
    return this.queue.filter(qs => 
      qs.signal.symbol === symbol && 
      !qs.processed && 
      Date.now() < qs.expiresAt
    );
  }

  /**
   * Get queue status and metrics
   */
  getStatus() {
    const now = Date.now();
    
    const active = this.queue.filter(qs => !qs.processed && now < qs.expiresAt);
    const processing = this.queue.filter(qs => qs.processed && now < qs.expiresAt);
    const expired = this.queue.filter(qs => now >= qs.expiresAt);
    
    return {
      total: this.queue.length,
      active: active.length,
      processing: processing.length,
      expired: expired.length,
      metrics: { ...this.metrics },
      topSignals: active.slice(0, 5).map(qs => ({
        symbol: qs.signal.symbol,
        action: qs.signal.action,
        strength: qs.signal.strength,
        priority: qs.priority,
        waitTime: now - qs.queuedAt
      }))
    };
  }

  /**
   * Clear all signals (useful for emergency stops)
   */
  clear(): void {
    const cleared = this.queue.length;
    this.queue = [];
    this.metrics.currentSize = 0;
    
    logger.info(`Cleared ${cleared} signals from queue`);
    this.emit('queueCleared', { count: cleared });
  }

  /**
   * Update queue configuration
   */
  updateConfig(newConfig: Partial<SignalQueueConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('SignalQueue configuration updated');
  }

  /**
   * Private methods
   */
  private generateSignalHash(signal: TradingSignal): string {
    // Create hash based on symbol and action for deduplication
    return `${signal.symbol}_${signal.action}_${Math.floor(signal.strength / 10)}`;
  }

  private isDuplicate(signalHash: string): boolean {
    const now = Date.now();
    const windowStart = now - this.config.deduplicationWindow;
    
    // Clean old entries
    for (const entry of this.processed) {
      const [, timestamp] = entry.split(':');
      if (parseInt(timestamp) < windowStart) {
        this.processed.delete(entry);
      }
    }

    // Check for duplicates in current window
    for (const entry of this.processed) {
      const [hash, timestamp] = entry.split(':');
      if (hash === signalHash && parseInt(timestamp) >= windowStart) {
        return true;
      }
    }

    return false;
  }

  private calculatePriority(signal: TradingSignal): number {
    const weights = this.config.priorityWeights;
    
    // Normalize values
    const strengthScore = signal.strength / 100; // 0-1
    const recencyScore = 1.0; // New signals get max recency
    const volumeScore = signal.indicators.volume > signal.indicators.avgVolume ? 1.0 : 0.5;
    
    // Calculate weighted priority
    const priority = 
      (strengthScore * weights.strength) +
      (recencyScore * weights.recency) +
      (volumeScore * weights.volume);
    
    // Scale to 0-100 range
    return Math.round(priority * 100);
  }

  private insertByPriority(queuedSignal: QueuedSignal): void {
    let inserted = false;
    
    for (let i = 0; i < this.queue.length; i++) {
      if (queuedSignal.priority > this.queue[i].priority) {
        this.queue.splice(i, 0, queuedSignal);
        inserted = true;
        break;
      }
    }
    
    if (!inserted) {
      this.queue.push(queuedSignal);
    }
  }

  private removeLowestPrioritySignal(): void {
    if (this.queue.length === 0) return;
    
    // Find lowest priority unprocessed signal
    let lowestIndex = -1;
    let lowestPriority = Infinity;
    
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const qs = this.queue[i];
      if (!qs.processed && qs.priority < lowestPriority) {
        lowestPriority = qs.priority;
        lowestIndex = i;
      }
    }
    
    if (lowestIndex !== -1) {
      const removed = this.queue.splice(lowestIndex, 1)[0];
      logger.debug(`Removed lowest priority signal: ${removed.signal.symbol}`);
    }
  }

  private updateAverageWaitTime(waitTime: number): void {
    if (this.metrics.averageWaitTime === 0) {
      this.metrics.averageWaitTime = waitTime;
    } else {
      this.metrics.averageWaitTime = 
        (this.metrics.averageWaitTime + waitTime) / 2;
    }
  }

  private startCleanupProcess(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanExpiredSignals();
    }, 5000); // Clean every 5 seconds
  }

  private startThroughputTracking(): void {
    this.lastThroughputCheck = Date.now();
    
    setInterval(() => {
      const now = Date.now();
      const timeDiff = (now - this.lastThroughputCheck) / 1000 / 60; // minutes
      
      this.metrics.throughput = this.throughputCounter / timeDiff;
      this.throughputCounter = 0;
      this.lastThroughputCheck = now;
    }, 60000); // Update every minute
  }

  private cleanExpiredSignals(): void {
    const now = Date.now();
    const originalLength = this.queue.length;
    
    this.queue = this.queue.filter(qs => {
      if (now >= qs.expiresAt) {
        this.metrics.totalExpired++;
        this.emit('signalExpired', qs);
        return false;
      }
      return true;
    });
    
    const removedCount = originalLength - this.queue.length;
    this.metrics.currentSize = this.queue.length;
    
    if (removedCount > 0) {
      logger.debug(`Cleaned ${removedCount} expired signals from queue`);
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    this.clear();
    this.processed.clear();
    
    logger.info('PrioritySignalQueue destroyed');
  }
}