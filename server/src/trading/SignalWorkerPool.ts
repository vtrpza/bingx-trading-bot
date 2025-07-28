import { EventEmitter } from 'events';
import { apiRequestManager } from '../services/APIRequestManager';
import { SignalGenerator, TradingSignal } from './signalGenerator';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface SignalTask {
  id: string;
  symbol: string;
  timestamp: number;
  priority: number;
  retries: number;
  maxRetries: number;
}

export interface WorkerMetrics {
  totalProcessed: number;
  successCount: number;
  errorCount: number;
  avgProcessingTime: number;
  lastProcessedAt: number;
}

export interface SignalWorkerConfig {
  maxWorkers: number;
  maxConcurrentTasks: number;
  taskTimeout: number;
  retryAttempts: number;
  taskDelay: number;
  signalConfig: any;
  enableParallelProcessing?: boolean;
  batchSize?: number;
}

class SignalWorker extends EventEmitter {
  private id: string;
  private isActive: boolean = false;
  private currentTask: SignalTask | null = null;
  private signalGenerator: SignalGenerator;
  private metrics: WorkerMetrics;

  constructor(id: string, signalConfig: any) {
    super();
    this.id = id;
    this.signalGenerator = new SignalGenerator(signalConfig);
    this.metrics = {
      totalProcessed: 0,
      successCount: 0,
      errorCount: 0,
      avgProcessingTime: 0,
      lastProcessedAt: 0
    };
  }

  async processTask(task: SignalTask): Promise<TradingSignal | null> {
    if (this.isActive) {
      throw new Error(`Worker ${this.id} is already processing a task`);
    }

    this.isActive = true;
    this.currentTask = task;
    const startTime = Date.now();

    try {
      logger.info(`🔨 Worker ${this.id} analyzing ${task.symbol}...`);

      // Get market data using APIRequestManager (eliminates parallel calls)
      const klines = await Promise.race([
        apiRequestManager.getKlines(task.symbol, '5m', 100),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Market data timeout')), 15000)
        )
      ]) as any;

      if (!klines || klines.code !== 0 || !klines.data || !Array.isArray(klines.data)) {
        logger.error(`Invalid market data for ${task.symbol}:`, {
          hasKlines: !!klines,
          code: klines?.code,
          hasData: !!klines?.data,
          isArray: Array.isArray(klines?.data),
          dataLength: klines?.data?.length,
          message: klines?.msg,
          demoMode: process.env.DEMO_MODE
        });
        throw new Error(`Invalid market data for ${task.symbol}: ${klines?.msg || 'No data'}`);
      }

      if (klines.data.length < 50) {
        throw new Error(`Insufficient data: ${klines.data.length} candles`);
      }

      // Convert and validate candles
      const candles = klines.data.map((k: any) => ({
        timestamp: parseInt(k.time || k[0]),
        open: parseFloat(k.open !== undefined ? k.open : k[1]),
        high: parseFloat(k.high !== undefined ? k.high : k[2]),
        low: parseFloat(k.low !== undefined ? k.low : k[3]),
        close: parseFloat(k.close !== undefined ? k.close : k[4]),
        volume: parseFloat(k.volume !== undefined ? k.volume : k[5])
      })).filter((candle: any) => 
        !isNaN(candle.open) && !isNaN(candle.high) && 
        !isNaN(candle.low) && !isNaN(candle.close) && 
        candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0
      );

      if (candles.length < 50) {
        throw new Error(`Insufficient valid candles: ${candles.length}`);
      }

      // Generate signal
      const signal = this.signalGenerator.generateSignal(task.symbol, candles);
      
      // Update metrics
      const processingTime = Date.now() - startTime;
      this.updateMetrics(true, processingTime);
      
      logger.debug(`Worker ${this.id} completed ${task.symbol} in ${processingTime}ms`, {
        action: signal.action,
        strength: signal.strength
      });

      this.emit('taskCompleted', {
        workerId: this.id,
        task,
        signal,
        processingTime
      });

      return signal;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.updateMetrics(false, processingTime);
      
      logger.warn(`Worker ${this.id} failed processing ${task.symbol}: ${
        error instanceof Error ? error.message : String(error)
      }`);
      
      this.emit('taskError', {
        workerId: this.id,
        task,
        error: error instanceof Error ? error.message : String(error),
        processingTime
      });

      return null;
    } finally {
      this.isActive = false;
      this.currentTask = null;
    }
  }

  private updateMetrics(success: boolean, processingTime: number) {
    this.metrics.totalProcessed++;
    
    if (success) {
      this.metrics.successCount++;
    } else {
      this.metrics.errorCount++;
    }

    // Update average processing time (simple moving average)
    if (this.metrics.avgProcessingTime === 0) {
      this.metrics.avgProcessingTime = processingTime;
    } else {
      this.metrics.avgProcessingTime = 
        (this.metrics.avgProcessingTime + processingTime) / 2;
    }

    this.metrics.lastProcessedAt = Date.now();
  }

  isAvailable(): boolean {
    return !this.isActive;
  }

  getId(): string {
    return this.id;
  }

  getMetrics(): WorkerMetrics {
    return { ...this.metrics };
  }

  getCurrentTask(): SignalTask | null {
    return this.currentTask;
  }
}

export class SignalWorkerPool extends EventEmitter {
  private workers: Map<string, SignalWorker> = new Map();
  private taskQueue: SignalTask[] = [];
  private config: SignalWorkerConfig;
  private isRunning: boolean = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private consecutiveErrors: number = 0;
  private lastErrorTime: number = 0;
  private circuitBreakerOpen: boolean = false;

  constructor(config: Partial<SignalWorkerConfig> = {}) {
    super();
    
    this.config = {
      maxWorkers: config.enableParallelProcessing ? 12 : 3, // 🚀 12 workers for ultra performance (4x increase)
      maxConcurrentTasks: config.enableParallelProcessing ? 15 : 3, // 🚀 15 concurrent tasks
      taskTimeout: 10000, // 🚀 AGGRESSIVE: 10s timeout (down from 30s)
      retryAttempts: 1, // 🚀 FAST FAIL: Only 1 retry for speed
      taskDelay: config.enableParallelProcessing ? 100 : 500, // 🚀 ULTRA FAST: 100ms delay
      signalConfig: {},
      enableParallelProcessing: true, // 🚀 DEFAULT TO PARALLEL
      batchSize: 25, // 🚀 Larger batches for efficiency
      ...config
    };

    this.initializeWorkers();
  }

  private initializeWorkers() {
    for (let i = 0; i < this.config.maxWorkers; i++) {
      const workerId = `worker-${i}`;
      const worker = new SignalWorker(workerId, this.config.signalConfig);
      
      worker.on('taskCompleted', (result) => {
        // Reset consecutive errors on successful task completion
        this.consecutiveErrors = 0;
        
        logger.debug(`Task completed for ${result.task.symbol}, emitting signalGenerated event`, {
          signal: result.signal?.action,
          strength: result.signal?.strength
        });
        this.emit('signalGenerated', result.signal);
        this.processNextTask();
      });
      
      worker.on('taskError', (error) => {
        this.handleTaskError(error.task, error.error);
        this.processNextTask();
      });
      
      this.workers.set(workerId, worker);
    }

    logger.info(`SignalWorkerPool initialized with ${this.config.maxWorkers} workers`);
  }

  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.processingInterval = setInterval(() => {
      this.processQueuedTasks();
    }, 100); // Check every 100ms

    logger.info('SignalWorkerPool started');
  }

  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Clear queue
    this.taskQueue = [];
    
    logger.info('SignalWorkerPool stopped');
  }

  addSymbols(symbols: string[], priority: number = 1): string[] {
    const taskIds: string[] = [];
    const currentTime = Date.now();
    
    // Batch processing for efficiency
    const batchSize = this.config.batchSize || 10;
    const symbolBatches = [];
    
    for (let i = 0; i < symbols.length; i += batchSize) {
      symbolBatches.push(symbols.slice(i, i + batchSize));
    }

    for (const symbol of symbols) {
      // Fast deduplication check (reduced window)
      const existingTask = this.taskQueue.find(task => 
        task.symbol === symbol && (currentTime - task.timestamp) < 15000
      );

      if (existingTask) {
        continue;
      }

      const task: SignalTask = {
        id: uuidv4(),
        symbol,
        timestamp: currentTime,
        priority,
        retries: 0,
        maxRetries: this.config.retryAttempts
      };

      this.taskQueue.push(task);
      taskIds.push(task.id);
    }

    // Efficient sorting
    this.taskQueue.sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);

    logger.debug(`⚡ Queued ${taskIds.length}/${symbols.length} symbols (${this.config.enableParallelProcessing ? 'parallel' : 'sequential'} mode)`);
    
    // Trigger processing
    this.processQueuedTasks();

    return taskIds;
  }

  private processQueuedTasks() {
    if (!this.isRunning || this.taskQueue.length === 0) {
      return;
    }

    // Circuit breaker check
    if (this.circuitBreakerOpen) {
      const currentTime = Date.now();
      if (currentTime - this.lastErrorTime > 300000) {
        this.circuitBreakerOpen = false;
        this.consecutiveErrors = 0;
        logger.info('⚡ Circuit breaker closed - resuming processing');
      } else {
        return;
      }
    }

    // Fast cleanup of expired tasks
    const currentTime = Date.now();
    const originalLength = this.taskQueue.length;
    this.taskQueue = this.taskQueue.filter(task => 
      (currentTime - task.timestamp) < 45000 // Reduced expiry time
    );
    
    if (originalLength !== this.taskQueue.length) {
      logger.debug(`⚡ Cleaned ${originalLength - this.taskQueue.length} expired tasks`);
    }

    const availableWorkers = Array.from(this.workers.values())
      .filter(worker => worker.isAvailable());

    if (availableWorkers.length === 0) {
      return;
    }

    // Process tasks (parallel or sequential based on config)
    if (this.config.enableParallelProcessing) {
      // Parallel processing - multiple workers
      const tasksToProcess = Math.min(availableWorkers.length, this.taskQueue.length);
      
      for (let i = 0; i < tasksToProcess; i++) {
        const worker = availableWorkers[i];
        const task = this.taskQueue.shift();
        
        if (task) {
          this.processTask(worker, task);
        }
      }
    } else {
      // Sequential processing - single worker
      const worker = availableWorkers[0];
      const task = this.taskQueue.shift();
      
      if (task) {
        this.processTask(worker, task);
      }
    }
  }

  private async processTask(worker: SignalWorker, task: SignalTask) {
    const startTime = Date.now();
    logger.debug(`Starting sequential task ${task.id} for symbol ${task.symbol} on worker ${worker.getId()}`);
    
    try {
      await Promise.race([
        worker.processTask(task),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Task timeout')), this.config.taskTimeout)
        )
      ]);
      
      const duration = Date.now() - startTime;
      logger.debug(`Sequential task ${task.id} completed successfully in ${duration}ms`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      logger.warn(`Sequential task ${task.id} for ${task.symbol} failed after ${duration}ms: ${errorMessage}`);
      this.handleTaskError(task, errorMessage);
    }
  }

  private processNextTask() {
    // 🚀 ULTRA-FAST: Minimal delay for maximum throughput
    const delay = this.config.enableParallelProcessing ? 10 : 50; // 10ms for parallel, 50ms for sequential
    setTimeout(() => this.processQueuedTasks(), delay);
  }

  private handleTaskError(task: SignalTask, error: string) {
    // Track consecutive errors for circuit breaker
    this.consecutiveErrors++;
    this.lastErrorTime = Date.now();
    
    // Check if error is rate limit related
    const isRateLimitError = error.includes('Rate limit') || 
                           error.includes('429') || 
                           error.includes('rate limited') ||
                           error.includes('109400');
    
    // Lower threshold for rate limit errors (more aggressive circuit breaker)
    const errorThreshold = isRateLimitError ? 5 : 10;
    
    // Open circuit breaker if too many consecutive errors
    if (this.consecutiveErrors >= errorThreshold && !this.circuitBreakerOpen) {
      this.circuitBreakerOpen = true;
      const pauseDuration = isRateLimitError ? '10 minutes' : '5 minutes';
      const pauseMs = isRateLimitError ? 600000 : 300000;
      
      logger.error(`Circuit breaker opened after ${this.consecutiveErrors} consecutive errors (${isRateLimitError ? 'rate limit' : 'general'} errors). Pausing for ${pauseDuration}.`);
      
      // Clear the task queue to prevent processing more failing tasks
      this.taskQueue = [];
      
      // Auto-close circuit breaker after pause duration
      setTimeout(() => {
        if (this.circuitBreakerOpen) {
          this.circuitBreakerOpen = false;
          this.consecutiveErrors = 0;
          logger.info(`Circuit breaker auto-closed after ${pauseDuration} - resuming operations`);
        }
      }, pauseMs);
      
      this.emit('circuitBreakerOpened', {
        consecutiveErrors: this.consecutiveErrors,
        lastError: error,
        isRateLimitError,
        pauseDuration
      });
    }
    
    if (task.retries < task.maxRetries) {
      task.retries++;
      task.timestamp = Date.now(); // Update timestamp for retry
      this.taskQueue.unshift(task); // Add to front of queue for retry
      
      logger.debug(`Retrying task ${task.id} for ${task.symbol} (attempt ${task.retries})`);
    } else {
      logger.warn(`Task ${task.id} for ${task.symbol} failed after ${task.retries} retries: ${error}`);
      
      this.emit('taskFailed', {
        task,
        error,
        finalAttempt: true
      });
    }
  }

  getStatus() {
    const workerMetrics = Array.from(this.workers.values()).map(worker => ({
      id: worker.getId(),
      isAvailable: worker.isAvailable(),
      currentTask: worker.getCurrentTask(),
      metrics: worker.getMetrics()
    }));

    return {
      isRunning: this.isRunning,
      queueLength: this.taskQueue.length,
      workers: workerMetrics,
      config: this.config,
      totalWorkers: this.workers.size,
      availableWorkers: workerMetrics.filter(w => w.isAvailable).length,
      activeWorkers: workerMetrics.filter(w => !w.isAvailable).length,
      circuitBreaker: {
        isOpen: this.circuitBreakerOpen,
        consecutiveErrors: this.consecutiveErrors,
        lastErrorTime: this.lastErrorTime
      }
    };
  }

  getMetrics() {
    const workerMetrics = Array.from(this.workers.values()).map(w => w.getMetrics());
    
    const totalProcessed = workerMetrics.reduce((sum, m) => sum + m.totalProcessed, 0);
    const totalSuccess = workerMetrics.reduce((sum, m) => sum + m.successCount, 0);
    const totalErrors = workerMetrics.reduce((sum, m) => sum + m.errorCount, 0);
    const avgProcessingTime = workerMetrics.length > 0 
      ? workerMetrics.reduce((sum, m) => sum + m.avgProcessingTime, 0) / workerMetrics.length
      : 0;

    return {
      totalProcessed,
      successRate: totalProcessed > 0 ? (totalSuccess / totalProcessed) * 100 : 0,
      errorRate: totalProcessed > 0 ? (totalErrors / totalProcessed) * 100 : 0,
      avgProcessingTime,
      queueLength: this.taskQueue.length,
      activeWorkers: workerMetrics.filter(w => w.lastProcessedAt > Date.now() - 10000).length
    };
  }

  updateConfig(newConfig: Partial<SignalWorkerConfig>) {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };
    
    // Reinitialize workers if parallel processing mode changed
    if (oldConfig.enableParallelProcessing !== this.config.enableParallelProcessing) {
      logger.info(`⚡ Switching to ${this.config.enableParallelProcessing ? 'parallel' : 'sequential'} processing mode`);
      
      // Stop current workers
      this.workers.clear();
      
      // Reinitialize with new config
      this.initializeWorkers();
    }
    
    // Update worker signal configs
    for (const worker of this.workers.values()) {
      (worker as any).signalGenerator.updateConfig(this.config.signalConfig);
    }
    
    logger.info('⚡ SignalWorkerPool configuration updated');
  }
  
  // Performance mode switching
  enableParallelMode(): void {
    this.updateConfig({ enableParallelProcessing: true });
  }
  
  enableSequentialMode(): void {
    this.updateConfig({ enableParallelProcessing: false });
  }
}