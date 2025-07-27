import { EventEmitter } from 'events';
import { bingxClient } from '../services/bingxClient';
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
  signalConfig: any;
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
      logger.debug(`Worker ${this.id} processing symbol: ${task.symbol}`);

      // Get market data with timeout
      const klines = await Promise.race([
        bingxClient.getKlines(task.symbol, '5m', 100),
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
      maxWorkers: 3, // Reduced from 5 to prevent rate limit issues
      maxConcurrentTasks: 10, // Reduced from 15
      taskTimeout: 20000, // Increased from 8000ms to 20000ms
      retryAttempts: 2,
      signalConfig: {},
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

    for (const symbol of symbols) {
      // Check if symbol already in queue (deduplication)
      const existingTask = this.taskQueue.find(task => 
        task.symbol === symbol && (currentTime - task.timestamp) < 30000
      );

      if (existingTask) {
        logger.debug(`Symbol ${symbol} already in queue, skipping`);
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

    // Sort queue by priority (higher priority first)
    this.taskQueue.sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);

    logger.debug(`Added ${taskIds.length} symbols to queue (${symbols.length} requested)`);
    
    // Trigger immediate processing
    this.processQueuedTasks();

    return taskIds;
  }

  private processQueuedTasks() {
    if (!this.isRunning || this.taskQueue.length === 0) {
      return;
    }

    // Check circuit breaker
    if (this.circuitBreakerOpen) {
      const currentTime = Date.now();
      // Open circuit breaker for 5 minutes after 10 consecutive errors
      if (currentTime - this.lastErrorTime > 300000) { // 5 minutes
        this.circuitBreakerOpen = false;
        this.consecutiveErrors = 0;
        logger.info('Circuit breaker closed - resuming task processing');
      } else {
        logger.debug('Circuit breaker open - skipping task processing');
        return;
      }
    }

    // Remove expired tasks (older than 60 seconds)
    const currentTime = Date.now();
    this.taskQueue = this.taskQueue.filter(task => 
      (currentTime - task.timestamp) < 60000
    );

    // Get available workers
    const availableWorkers = Array.from(this.workers.values())
      .filter(worker => worker.isAvailable());

    if (availableWorkers.length === 0) {
      return;
    }

    // Process tasks up to available workers (parallel processing)
    const tasksToProcess = this.taskQueue.splice(0, availableWorkers.length);

    for (let i = 0; i < tasksToProcess.length && i < availableWorkers.length; i++) {
      const task = tasksToProcess[i];
      const worker = availableWorkers[i];
      
      this.processTask(worker, task);
    }
  }

  private async processTask(worker: SignalWorker, task: SignalTask) {
    const startTime = Date.now();
    logger.debug(`Starting task ${task.id} for symbol ${task.symbol} on worker ${worker.getId()}`);
    
    try {
      await Promise.race([
        worker.processTask(task),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Task timeout')), this.config.taskTimeout)
        )
      ]);
      
      const duration = Date.now() - startTime;
      logger.debug(`Task ${task.id} completed successfully in ${duration}ms`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      logger.warn(`Task ${task.id} for ${task.symbol} failed after ${duration}ms: ${errorMessage}`);
      this.handleTaskError(task, errorMessage);
    }
  }

  private processNextTask() {
    // Process next task if any are queued
    setTimeout(() => this.processQueuedTasks(), 10);
  }

  private handleTaskError(task: SignalTask, error: string) {
    // Track consecutive errors for circuit breaker
    this.consecutiveErrors++;
    this.lastErrorTime = Date.now();
    
    // Open circuit breaker if too many consecutive errors
    if (this.consecutiveErrors >= 10 && !this.circuitBreakerOpen) {
      this.circuitBreakerOpen = true;
      logger.error(`Circuit breaker opened after ${this.consecutiveErrors} consecutive errors. Pausing for 5 minutes.`);
      
      // Clear the task queue to prevent processing more failing tasks
      this.taskQueue = [];
      
      this.emit('circuitBreakerOpened', {
        consecutiveErrors: this.consecutiveErrors,
        lastError: error
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
    this.config = { ...this.config, ...newConfig };
    
    // Update worker signal configs
    for (const worker of this.workers.values()) {
      (worker as any).signalGenerator.updateConfig(this.config.signalConfig);
    }
    
    logger.info('SignalWorkerPool configuration updated');
  }
}