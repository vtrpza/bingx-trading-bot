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
  minVolumeUSDT?: number;
  symbolProcessingEnabled?: boolean;
  
  // 🚀 Progressive Symbol Loading Configuration
  progressiveLoading?: {
    enabled: boolean;
    initialWaveSize: number;    // Start with N symbols
    waveIncrement: number;      // Add N symbols each wave
    waveInterval: number;       // Interval between waves (ms)
    maxSymbols: number;         // Maximum symbols to reach
    scalingThresholds: {
      successRate: number;      // Min success rate to scale
      maxQueueLength: number;   // Max queue length to scale
      maxErrorRate: number;     // Max error rate to scale
    };
  };
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
  private signalGenerator: SignalGenerator;
  private metrics: WorkerMetrics;
  private availableSymbols: string[] = [];
  
  // 🚀 Progressive Loading Properties
  private allProcessedSymbols: {symbol: string, volume: number}[] = [];
  private currentSymbolIndex: number = 0;
  private progressiveLoadingTimer: NodeJS.Timeout | null = null;
  private waveCount: number = 0;
  private lazyLoadingQueue: string[] = [];
  private lazyLoadingTimer: NodeJS.Timeout | null = null;


  constructor(config: Partial<SignalWorkerConfig> = {}) {
    super();
    
    this.config = {
      maxWorkers: config.enableParallelProcessing ? 24 : 3, // 🚀 12 workers for ultra performance (4x increase)
      maxConcurrentTasks: config.enableParallelProcessing ? 15 : 3, // 🚀 15 concurrent tasks
      taskTimeout: 10000, // 🚀 AGGRESSIVE: 10s timeout (down from 30s)
      retryAttempts: 1, // 🚀 FAST FAIL: Only 1 retry for speed
      taskDelay: config.enableParallelProcessing ? 100 : 500, // 🚀 ULTRA FAST: 100ms delay
      signalConfig: {},
      enableParallelProcessing: true, // 🚀 DEFAULT TO PARALLEL
      batchSize: 25, // 🚀 Larger batches for efficiency
      minVolumeUSDT: 10000, // Default minimum volume
      symbolProcessingEnabled: true, // Enable symbol processing
      
      // 🚀 Progressive Loading Defaults
      progressiveLoading: {
        enabled: true,
        initialWaveSize: 25,        // Start with 20 symbols
        waveIncrement: 25,          // Add 20 symbols each wave
        waveInterval: 2500,       // 1 minutes between waves
        maxSymbols: 100,            // Max 100 symbols
        scalingThresholds: {
          successRate: 0.8,         // 80% success rate to scale
          maxQueueLength: 10,       // Max 10 items in queue
          maxErrorRate: 0.05        // Max 5% error rate
        },
        ...config.progressiveLoading
      },
      
      ...config
    };

    // Initialize SignalGenerator for batch processing
    this.signalGenerator = new SignalGenerator(this.config.signalConfig);
    
    // Initialize metrics
    this.metrics = {
      totalProcessed: 0,
      successCount: 0,
      errorCount: 0,
      avgProcessingTime: 0,
      lastProcessedAt: 0
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

  async start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    
    // 🚀 PROCESS SYMBOLS ALONGSIDE SIGNAL ENGINE START
    if (this.config.symbolProcessingEnabled) {
      logger.info('🔄 Processing symbols alongside signal engine startup...');
      await this.processAvailableSymbols();
    }
    
    this.processingInterval = setInterval(() => {
      this.processQueuedTasks();
    }, 100); // Check every 100ms

    logger.info('SignalWorkerPool started with symbol processing');
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

    // Clear progressive loading timer
    if (this.progressiveLoadingTimer) {
      clearTimeout(this.progressiveLoadingTimer);
      this.progressiveLoadingTimer = null;
    }
    
    // Clear lazy loading timer
    if (this.lazyLoadingTimer) {
      clearTimeout(this.lazyLoadingTimer);
      this.lazyLoadingTimer = null;
    }

    // Clear queue
    this.taskQueue = [];
    
    logger.info('SignalWorkerPool stopped');
  }

  addSymbols(symbols: string[], priority: number = 1): string[] {
    const taskIds: string[] = [];
    const currentTime = Date.now();
    
    // Ultra-fast deduplication using Set for O(1) lookups
    const existingSymbols = new Set(
      this.taskQueue
        .filter(task => (currentTime - task.timestamp) < 30000) // Extended window for batch processing
        .map(task => task.symbol)
    );

    // Filter new symbols only
    const newSymbols = symbols.filter(symbol => !existingSymbols.has(symbol));
    
    if (newSymbols.length === 0) {
      logger.debug('⚡ All symbols already queued, skipping');
      return [];
    }

    // Batch create tasks for better performance
    const newTasks: SignalTask[] = newSymbols.map(symbol => ({
      id: uuidv4(),
      symbol,
      timestamp: currentTime,
      priority,
      retries: 0,
      maxRetries: this.config.retryAttempts
    }));

    // Bulk add to queue
    this.taskQueue.push(...newTasks);
    taskIds.push(...newTasks.map(task => task.id));

    // Efficient sorting only if needed
    if (priority !== 1) {
      this.taskQueue.sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);
    }

    logger.debug(`🚀 ULTRA FAST: Queued ${taskIds.length}/${symbols.length} symbols (filtered ${symbols.length - newSymbols.length} duplicates)`);
    
    // Trigger batch processing
    this.processBatchTasks();

    return taskIds;
  }

  /**
   * ⚡ BATCH PROCESSING - Process multiple symbols simultaneously for maximum performance
   */
  private async processBatchTasks(): Promise<void> {
    if (!this.isRunning || this.taskQueue.length === 0) {
      return;
    }

    // Get batch of tasks to process
    const batchSize = this.config.enableParallelProcessing ? 
      Math.min(15, this.config.maxConcurrentTasks) : 8; // Larger batches for parallel mode
    
    const tasksToProcess = this.taskQueue.splice(0, batchSize);
    
    if (tasksToProcess.length === 0) {
      return;
    }

    logger.info(`🚀 BATCH PROCESSING: Starting ${tasksToProcess.length} symbols simultaneously`);
    const batchStartTime = Date.now();

    // Get all symbols for batch klines processing
    const symbols = tasksToProcess.map(task => task.symbol);
    
    try {
      // ⚡ ULTRA PERFORMANCE: Batch get all klines data at once
      const batchKlines = await apiRequestManager.getBatchKlines(symbols, '5m', 100);
      
      // Process signals in parallel using the pre-fetched data
      const signalPromises = tasksToProcess.map(async (task) => {
        const klines = batchKlines.get(task.symbol);
        if (!klines || klines.code !== 0 || !klines.data) {
          logger.warn(`⚠️ No klines data for ${task.symbol}, skipping signal generation`);
          return null;
        }

        return this.processTaskWithKlines(task, klines);
      });

      // Wait for all signals to complete
      const results = await Promise.allSettled(signalPromises);
      const successful = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
      
      const batchTime = Date.now() - batchStartTime;
      logger.info(`🎯 BATCH COMPLETED: ${successful}/${tasksToProcess.length} signals processed in ${batchTime}ms (${Math.round(tasksToProcess.length * 1000 / batchTime)} symbols/second)`);

    } catch (error) {
      logger.error('Batch processing failed:', error);
      
      // Fallback: Re-queue failed tasks
      this.taskQueue.unshift(...tasksToProcess);
    }

    // Continue processing if more tasks remain
    if (this.taskQueue.length > 0) {
      setTimeout(() => this.processBatchTasks(), 100);
    }
  }

  /**
   * Process a single task with pre-fetched klines data
   */
  private async processTaskWithKlines(task: SignalTask, klines: any): Promise<TradingSignal | null> {
    try {
      // Convert and validate candles (same logic as before)
      const candles = klines.data.map((k: any) => ({
        timestamp: parseInt(k.time || k[0]),
        open: parseFloat(k.open !== undefined ? k.open : k[1]),
        high: parseFloat(k.high !== undefined ? k.high : k[2]),
        low: parseFloat(k.low !== undefined ? k.low : k[3]),
        close: parseFloat(k.close !== undefined ? k.close : k[4]),
        volume: parseFloat(k.volume !== undefined ? k.volume : k[5])
      })).filter((candle: any) => 
        !isNaN(candle.timestamp) && 
        !isNaN(candle.open) && 
        !isNaN(candle.high) && 
        !isNaN(candle.low) && 
        !isNaN(candle.close) && 
        !isNaN(candle.volume)
      );

      if (candles.length < 50) {
        throw new Error(`Insufficient data: ${candles.length} candles`);
      }

      // Generate signal using existing SignalGenerator
      const signal = await this.signalGenerator.generateSignal(task.symbol, candles);
      
      if (signal) {
        this.emit('signal', signal);
        this.updateWorkerMetrics(true, Date.now() - task.timestamp);
      }

      return signal;

    } catch (error) {
      logger.error(`Signal generation failed for ${task.symbol}:`, error);
      this.updateWorkerMetrics(false, Date.now() - task.timestamp);
      return null;
    }
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

  /**
   * Update worker metrics for performance tracking
   */
  private updateWorkerMetrics(success: boolean, processingTime: number): void {
    if (success) {
      this.consecutiveErrors = 0; // Reset error count on success
    }
    
    // Update processing time metrics (simple moving average)
    const currentAvg = this.metrics.avgProcessingTime || 0;
    const count = this.metrics.totalProcessed || 0;
    this.metrics.avgProcessingTime = ((currentAvg * count) + processingTime) / (count + 1);
    
    this.metrics.totalProcessed = (this.metrics.totalProcessed || 0) + 1;
    this.metrics.lastProcessedAt = Date.now();
    
    if (success) {
      this.metrics.successCount = (this.metrics.successCount || 0) + 1;
    } else {
      this.metrics.errorCount = (this.metrics.errorCount || 0) + 1;
    }
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
      
      // Clear APIRequestManager queue during circuit breaker
      try {
        apiRequestManager.clearQueue();
      } catch (clearError) {
        logger.warn('Failed to clear API request queue:', clearError);
      }
      
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

  /**
   * Emergency stop method for circuit breaker integration
   */
  emergencyStop(): void {
    logger.warn('SignalWorkerPool emergency stop initiated');
    
    // Set circuit breaker open
    this.circuitBreakerOpen = true;
    this.consecutiveErrors = 0;
    
    // Clear all tasks
    this.taskQueue = [];
    
    // Stop processing
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    
    logger.info('SignalWorkerPool emergency stop completed');
  }
  
  // Performance mode switching
  enableParallelMode(): void {
    this.updateConfig({ enableParallelProcessing: true });
  }
  
  enableSequentialMode(): void {
    this.updateConfig({ enableParallelProcessing: false });
  }

  // 🚀 SYMBOL PROCESSING METHODS - Integrated with Signal Engine

  /**
   * Process available symbols and populate the symbol list
   */
  private async processAvailableSymbols(): Promise<void> {
    try {
      logger.info('🔄 Fetching all available symbols from exchange...');
      
      // Get all symbols from BingX using APIRequestManager
      const symbolsData: any = await apiRequestManager.getSymbols();
      
      if (!symbolsData.data || !Array.isArray(symbolsData.data)) {
        logger.warn('Invalid symbols data received from exchange');
        return;
      }

      // Filter for active USDT pairs only and limit initial processing
      const usdtSymbols = symbolsData.data
        .filter((contract: any) => 
          contract.status === 1 && // Active contracts only
          contract.symbol && 
          contract.symbol.endsWith('-USDT') // USDT pairs only
        )
        .slice(0, 500) // Process up to 500 symbols for better coverage
        .map((contract: any) => contract.symbol);

      if (usdtSymbols.length === 0) {
        logger.warn('No USDT symbols found from exchange');
        return;
      }

      // 🚀 ULTRA-FAST START: Process only initial batch for immediate start
      const initialBatchSize = Math.max(
        (this.config.progressiveLoading?.initialWaveSize || 20) * 3, // 3x buffer for filtering
        50 // Minimum 50 for good selection
      );
      
      logger.info(`🚀 FAST START: Processing initial batch of ${initialBatchSize} symbols for immediate trading`);
      
      // Get volume data for ONLY the initial batch
      const initialSymbols = usdtSymbols.slice(0, initialBatchSize);
      const initialSymbolsWithVolume = await this.getSymbolVolumes(initialSymbols);
      
      // Sort initial batch by volume
      const sortedInitialSymbols = initialSymbolsWithVolume
        .sort((a, b) => b.volume - a.volume)
        .filter(item => item.volume >= (this.config.minVolumeUSDT || 10000));

      if (sortedInitialSymbols.length === 0) {
        logger.warn('No symbols meet minimum volume criteria in initial batch');
        return;
      }

      // Store initial processed symbols
      this.allProcessedSymbols = sortedInitialSymbols;
      
      // 🚀 Schedule lazy loading of remaining symbols in background
      this.scheduleLazySymbolLoading(usdtSymbols.slice(initialBatchSize));
      
      // 🚀 PROGRESSIVE LOADING: Start with initial wave
      if (this.config.progressiveLoading?.enabled) {
        await this.loadInitialSymbolWave();
      } else {
        // Legacy mode: Load all symbols at once (limit to 50)
        const eligibleSymbols = this.allProcessedSymbols
          .slice(0, 50)
          .map(item => item.symbol);
          
        this.availableSymbols = eligibleSymbols;
        
        logger.info(`🚀 Symbol processing completed (legacy mode): ${eligibleSymbols.length} symbols`, {
          demoMode: process.env.DEMO_MODE === 'true',
          sampleSymbols: eligibleSymbols.slice(0, 5),
          minVolume: this.config.minVolumeUSDT
        });

        this.emit('symbolsProcessed', {
          symbols: eligibleSymbols,
          count: eligibleSymbols.length
        });
      }

    } catch (error) {
      logger.error('Failed to process available symbols:', error);
    }
  }

  /**
   * 🚀 PROGRESSIVE LOADING: Load initial wave of symbols
   */
  private async loadInitialSymbolWave(): Promise<void> {
    const waveSize = this.config.progressiveLoading?.initialWaveSize || 20;
    
    if (this.allProcessedSymbols.length === 0) {
      logger.warn('No symbols available for progressive loading');
      return;
    }

    // Load first wave
    const initialWave = this.allProcessedSymbols
      .slice(0, waveSize)
      .map(item => item.symbol);
    
    this.availableSymbols = initialWave;
    this.currentSymbolIndex = waveSize;
    this.waveCount = 1;
    
    logger.info(`🚀 PROGRESSIVE LOADING: Wave ${this.waveCount} loaded with ${initialWave.length} symbols`, {
      symbols: initialWave.slice(0, 3).join(', ') + '...',
      totalAvailable: this.allProcessedSymbols.length,
      progressPercent: ((this.currentSymbolIndex / this.allProcessedSymbols.length) * 100).toFixed(1)
    });

    // Emit initial symbols
    this.emit('symbolsProcessed', {
      symbols: initialWave,
      count: initialWave.length,
      wave: this.waveCount,
      totalWaves: Math.ceil(this.allProcessedSymbols.length / waveSize)
    });

    // Schedule next wave
    this.scheduleNextSymbolWave();
  }

  /**
   * 🚀 PROGRESSIVE LOADING: Add next wave of symbols
   */
  private addSymbolWave(): void {
    if (!this.config.progressiveLoading?.enabled) {
      return;
    }

    const waveSize = this.config.progressiveLoading.waveIncrement;
    const maxSymbols = this.config.progressiveLoading.maxSymbols;
    
    // Check if we've reached maximum symbols or end of available symbols
    if (this.availableSymbols.length >= maxSymbols || this.currentSymbolIndex >= this.allProcessedSymbols.length) {
      logger.info(`🎯 Progressive loading complete: ${this.availableSymbols.length} symbols loaded`);
      return;
    }

    // Check performance metrics before scaling
    if (!this.shouldScaleUp()) {
      logger.info('⏳ Progressive loading paused - waiting for better performance metrics');
      this.scheduleNextSymbolWave(); // Try again later
      return;
    }

    // Get next wave of symbols
    const nextWaveEnd = Math.min(this.currentSymbolIndex + waveSize, this.allProcessedSymbols.length);
    const nextWave = this.allProcessedSymbols
      .slice(this.currentSymbolIndex, nextWaveEnd)
      .map(item => item.symbol);

    if (nextWave.length === 0) {
      logger.info('🎯 Progressive loading complete - no more symbols available');
      return;
    }

    // Add to available symbols
    this.availableSymbols.push(...nextWave);
    this.currentSymbolIndex = nextWaveEnd;
    this.waveCount++;

    logger.info(`🚀 PROGRESSIVE LOADING: Wave ${this.waveCount} added ${nextWave.length} symbols`, {
      newSymbols: nextWave.slice(0, 3).join(', ') + '...',
      totalActive: this.availableSymbols.length,
      remaining: this.allProcessedSymbols.length - this.currentSymbolIndex,
      progressPercent: ((this.currentSymbolIndex / this.allProcessedSymbols.length) * 100).toFixed(1)
    });

    // Emit wave update
    this.emit('symbolWaveAdded', {
      newSymbols: nextWave,
      totalSymbols: this.availableSymbols.length,
      wave: this.waveCount,
      progress: (this.currentSymbolIndex / this.allProcessedSymbols.length) * 100
    });

    // Schedule next wave if more symbols available
    if (this.currentSymbolIndex < this.allProcessedSymbols.length && this.availableSymbols.length < maxSymbols) {
      this.scheduleNextSymbolWave();
    }
  }

  /**
   * Schedule next symbol wave based on interval and performance
   */
  private scheduleNextSymbolWave(): void {
    if (this.progressiveLoadingTimer) {
      clearTimeout(this.progressiveLoadingTimer);
    }

    const interval = this.config.progressiveLoading?.waveInterval || 5000; // 2 minutes default
    
    this.progressiveLoadingTimer = setTimeout(() => {
      if (this.isRunning && !this.circuitBreakerOpen) {
        this.addSymbolWave();
      }
    }, interval);
  }

  /**
   * Check if system should scale up based on performance metrics
   */
  private shouldScaleUp(): boolean {
    const thresholds = this.config.progressiveLoading?.scalingThresholds;
    if (!thresholds) return true;

    // Get current metrics
    const metrics = this.getMetrics();
    const queueStatus = this.getStatus();

    // Check success rate
    if (metrics.successRate < thresholds.successRate * 100) {
      logger.debug(`Progressive loading: Success rate too low (${metrics.successRate.toFixed(1)}% < ${thresholds.successRate * 100}%)`);
      return false;
    }

    // Check queue length
    if (queueStatus.queueLength > thresholds.maxQueueLength) {
      logger.debug(`Progressive loading: Queue too long (${queueStatus.queueLength} > ${thresholds.maxQueueLength})`);
      return false;
    }

    // Check error rate
    if (metrics.errorRate > thresholds.maxErrorRate * 100) {
      logger.debug(`Progressive loading: Error rate too high (${metrics.errorRate.toFixed(1)}% > ${thresholds.maxErrorRate * 100}%)`);
      return false;
    }

    // Check circuit breaker
    if (this.circuitBreakerOpen) {
      logger.debug('Progressive loading: Circuit breaker is open');
      return false;
    }

    return true;
  }

  /**
   * 🚀 LAZY LOADING: Schedule background loading of remaining symbols  
   */
  private scheduleLazySymbolLoading(remainingSymbols: string[]): void {
    if (remainingSymbols.length === 0) {
      logger.info('🎯 No additional symbols to lazy load');
      return;
    }

    this.lazyLoadingQueue = remainingSymbols;
    
    logger.info(`📦 LAZY LOADING: Scheduled ${remainingSymbols.length} symbols for background processing`);
    
    // Start lazy loading after 5 seconds (let initial wave start first)
    this.lazyLoadingTimer = setTimeout(() => {
      this.processLazyLoadingBatch();
    }, 5000);
  }

  /**
   * 🚀 LAZY LOADING: Process symbols in background batches
   */
  private async processLazyLoadingBatch(): Promise<void> {
    if (this.lazyLoadingQueue.length === 0 || !this.isRunning) {
      return;
    }

    const batchSize = 50; // Process 50 symbols at a time
    const batch = this.lazyLoadingQueue.splice(0, batchSize);
    
    logger.info(`📦 LAZY LOADING: Processing batch of ${batch.length} symbols (${this.lazyLoadingQueue.length} remaining)`);
    
    try {
      const symbolsWithVolume = await this.getSymbolVolumes(batch);
      const validSymbols = symbolsWithVolume
        .filter(item => item.volume >= (this.config.minVolumeUSDT || 10000))
        .sort((a, b) => b.volume - a.volume);

      // Add to processed symbols pool
      this.allProcessedSymbols.push(...validSymbols);
      
      // Sort entire pool by volume to maintain order
      this.allProcessedSymbols.sort((a, b) => b.volume - a.volume);
      
      // Limit total symbols
      const maxSymbols = this.config.progressiveLoading?.maxSymbols || 100;
      if (this.allProcessedSymbols.length > maxSymbols) {
        this.allProcessedSymbols = this.allProcessedSymbols.slice(0, maxSymbols);
      }

      logger.info(`📦 LAZY LOADING: Added ${validSymbols.length} symbols, total pool: ${this.allProcessedSymbols.length}`);

    } catch (error) {
      logger.warn(`Lazy loading batch failed:`, error);
    }

    // Schedule next batch if more symbols remain
    if (this.lazyLoadingQueue.length > 0 && this.isRunning) {
      this.lazyLoadingTimer = setTimeout(() => {
        this.processLazyLoadingBatch();
      }, 10000); // 10 seconds between batches
    } else {
      logger.info(`🎯 LAZY LOADING: Complete! Total symbol pool: ${this.allProcessedSymbols.length}`);
    }
  }

  /**
   * Get volume data for symbols with parallel processing
   */
  private async getSymbolVolumes(symbols: string[], batchSize = 20): Promise<{symbol: string, volume: number}[]> {
    const symbolsWithVolume: {symbol: string, volume: number}[] = [];
    
    logger.info(`🚀 Getting volume data for ${symbols.length} symbols with ${batchSize} parallel requests...`);
    const startTime = Date.now();
    
    // 🚀 ULTRA-AGGRESSIVE: 20 parallel requests with NO delays
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      
      // Parallel execution with aggressive error handling
      const promises = batch.map(async (symbol) => {
        try {
          // Use high priority for ticker requests during initialization
          const ticker: any = await apiRequestManager.getTicker(symbol, 1); // HIGH priority
          if (ticker.code === 0 && ticker.data) {
            const volume = parseFloat(ticker.data.quoteVolume || 0);
            return { symbol, volume };
          }
        } catch (error) {
          // Silent fail for speed - only log critical errors
          if (error instanceof Error && !error.message.includes('timeout')) {
            logger.debug(`Ticker failed for ${symbol}:`, error.message);
          }
        }
        return null;
      });

      // Execute all requests in parallel
      const results = await Promise.allSettled(promises);
      
      // Process results quickly
      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          symbolsWithVolume.push(result.value);
        }
      });

      // Progress logging every 100 symbols
      if (i % 100 === 0 && i > 0) {
        const progress = (i / symbols.length * 100).toFixed(1);
        const elapsed = Date.now() - startTime;
        const rate = i / (elapsed / 1000);
        logger.info(`📊 Symbol processing progress: ${progress}% (${i}/${symbols.length}) at ${rate.toFixed(1)} symbols/sec`);
      }
    }

    const totalTime = Date.now() - startTime;
    const rate = symbols.length / (totalTime / 1000);
    logger.info(`⚡ Symbol volume processing complete: ${symbolsWithVolume.length} symbols processed in ${totalTime}ms (${rate.toFixed(1)} symbols/sec)`);
    
    return symbolsWithVolume;
  }

  /**
   * Get the list of processed symbols
   */
  getAvailableSymbols(): string[] {
    return [...this.availableSymbols];
  }

  /**
   * Check if symbols have been processed
   */
  areSymbolsReady(): boolean {
    return this.availableSymbols.length > 0;
  }

  /**
   * Refresh symbol list
   */
  async refreshSymbols(): Promise<void> {
    if (this.config.symbolProcessingEnabled) {
      logger.info('🔄 Refreshing symbol list...');
      await this.processAvailableSymbols();
    }
  }

  /**
   * 🚀 PUBLIC API: Force load next symbol wave manually
   */
  forceNextSymbolWave(): void {
    if (this.config.progressiveLoading?.enabled) {
      logger.info('🚀 Manually forcing next symbol wave...');
      this.addSymbolWave();
    } else {
      logger.warn('Progressive loading is disabled - cannot force next wave');
    }
  }

  /**
   * 🚀 PUBLIC API: Get progressive loading status
   */
  getProgressiveLoadingStatus() {
    if (!this.config.progressiveLoading?.enabled) {
      return { enabled: false };
    }

    return {
      enabled: true,
      currentWave: this.waveCount,
      activeSymbols: this.availableSymbols.length,
      totalProcessedSymbols: this.allProcessedSymbols.length,
      remainingSymbols: this.allProcessedSymbols.length - this.currentSymbolIndex,
      progressPercent: this.allProcessedSymbols.length > 0 
        ? ((this.currentSymbolIndex / this.allProcessedSymbols.length) * 100).toFixed(1)
        : '0.0',
      isComplete: this.currentSymbolIndex >= this.allProcessedSymbols.length,
      nextWaveScheduled: this.progressiveLoadingTimer !== null,
      config: this.config.progressiveLoading,
      performance: {
        shouldScaleUp: this.shouldScaleUp(),
        metrics: this.getMetrics()
      }
    };
  }
}