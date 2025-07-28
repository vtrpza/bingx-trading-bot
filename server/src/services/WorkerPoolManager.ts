import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import path from 'path';

export interface WorkerTask<T = any, R = any> {
  id: string;
  type: string;
  data: T;
  priority: number;
  timeout: number;
  retries: number;
  createdAt: number;
}

export interface WorkerResult<R = any> {
  taskId: string;
  success: boolean;
  data?: R;
  error?: string;
  processingTime: number;
  workerId: string;
}

export interface WorkerPoolStats {
  poolSize: number;
  activeWorkers: number;
  idleWorkers: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  avgProcessingTime: number;
  cpuUsage: number;
  memoryUsage: number;
}

export interface PoolConfig {
  minWorkers: number;
  maxWorkers: number;
  maxQueueSize: number;
  taskTimeout: number;
  maxRetries: number;
  idleTimeout: number;
  workerScript: string;
}

/**
 * High-performance worker pool manager for parallel processing of asset data
 * Optimized for CPU-intensive tasks like data transformation and validation
 */
export class WorkerPoolManager extends EventEmitter {
  private workers: Map<string, Worker> = new Map();
  private availableWorkers: Set<string> = new Set();
  private busyWorkers: Set<string> = new Set();
  private taskQueue: WorkerTask[] = [];
  private activeTasks: Map<string, { task: WorkerTask; resolve: Function; reject: Function; startTime: number }> = new Map();
  private stats = {
    completedTasks: 0,
    failedTasks: 0,
    totalProcessingTime: 0
  };

  private config: PoolConfig;
  private isShuttingDown = false;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: Partial<PoolConfig> = {}) {
    super();
    
    this.config = {
      minWorkers: config.minWorkers || Math.max(1, Math.floor(require('os').cpus().length / 2)),
      maxWorkers: config.maxWorkers || require('os').cpus().length,
      maxQueueSize: config.maxQueueSize || 1000,
      taskTimeout: config.taskTimeout || 30000, // 30 seconds
      maxRetries: config.maxRetries || 3,
      idleTimeout: config.idleTimeout || 300000, // 5 minutes
      workerScript: config.workerScript || path.join(__dirname, 'AssetProcessorWorker.js')
    };

    this.initialize();
  }

  /**
   * Initialize the worker pool
   */
  private async initialize(): Promise<void> {
    logger.info(`Initializing worker pool with ${this.config.minWorkers}-${this.config.maxWorkers} workers`);

    // Create minimum number of workers
    for (let i = 0; i < this.config.minWorkers; i++) {
      await this.createWorker();
    }

    // Setup cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleWorkers();
      this.processQueue();
    }, 10000); // Every 10 seconds

    logger.info(`Worker pool initialized with ${this.workers.size} workers`);
  }

  /**
   * Create a new worker
   */
  private async createWorker(): Promise<string> {
    const workerId = `worker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      const worker = new Worker(this.config.workerScript, {
        workerData: { workerId }
      });

      this.setupWorkerHandlers(worker, workerId);
      
      this.workers.set(workerId, worker);
      this.availableWorkers.add(workerId);

      logger.debug(`Created worker ${workerId}`);
      return workerId;
    } catch (error) {
      logger.error(`Failed to create worker ${workerId}:`, error);
      throw error;
    }
  }

  /**
   * Setup event handlers for a worker
   */
  private setupWorkerHandlers(worker: Worker, workerId: string): void {
    worker.on('message', (result: WorkerResult) => {
      this.handleWorkerResult(workerId, result);
    });

    worker.on('error', (error) => {
      logger.error(`Worker ${workerId} error:`, error);
      this.handleWorkerError(workerId, error);
    });

    worker.on('exit', (code) => {
      logger.warn(`Worker ${workerId} exited with code ${code}`);
      this.handleWorkerExit(workerId);
    });
  }

  /**
   * Handle worker result
   */
  private handleWorkerResult(workerId: string, result: WorkerResult): void {
    const activeTask = this.activeTasks.get(result.taskId);
    if (!activeTask) {
      logger.warn(`Received result for unknown task ${result.taskId} from worker ${workerId}`);
      return;
    }

    const processingTime = Date.now() - activeTask.startTime;
    
    // Update statistics
    if (result.success) {
      this.stats.completedTasks++;
      this.stats.totalProcessingTime += processingTime;
      activeTask.resolve(result);
    } else {
      this.stats.failedTasks++;
      
      // Check if we should retry
      if (activeTask.task.retries > 0) {
        activeTask.task.retries--;
        logger.debug(`Retrying task ${result.taskId}, ${activeTask.task.retries} retries left`);
        this.taskQueue.unshift(activeTask.task); // Add back to front of queue
        activeTask.reject(new Error(`Task failed, retrying: ${result.error}`));
      } else {
        activeTask.reject(new Error(result.error || 'Task failed'));
      }
    }

    // Clean up task
    this.activeTasks.delete(result.taskId);
    this.busyWorkers.delete(workerId);
    this.availableWorkers.add(workerId);

    // Process next task in queue
    this.processQueue();
  }

  /**
   * Handle worker error
   */
  private handleWorkerError(workerId: string, error: Error): void {
    // Find and fail any active task for this worker
    for (const [taskId, activeTask] of this.activeTasks) {
      if (this.busyWorkers.has(workerId)) {
        activeTask.reject(error);
        this.activeTasks.delete(taskId);
        break;
      }
    }

    // Remove worker from all sets
    this.workers.delete(workerId);
    this.availableWorkers.delete(workerId);
    this.busyWorkers.delete(workerId);

    // Create replacement worker if not shutting down
    if (!this.isShuttingDown && this.workers.size < this.config.minWorkers) {
      this.createWorker().catch(err => {
        logger.error('Failed to create replacement worker:', err);
      });
    }
  }

  /**
   * Handle worker exit
   */
  private handleWorkerExit(workerId: string): void {
    this.handleWorkerError(workerId, new Error('Worker exited unexpectedly'));
  }

  /**
   * Process queued tasks
   */
  private processQueue(): void {
    while (this.taskQueue.length > 0 && this.availableWorkers.size > 0) {
      const task = this.taskQueue.shift()!;
      const workerId = Array.from(this.availableWorkers)[0];
      
      this.assignTaskToWorker(task, workerId);
    }

    // Create more workers if needed and possible
    if (this.taskQueue.length > 0 && 
        this.workers.size < this.config.maxWorkers && 
        this.availableWorkers.size === 0) {
      this.createWorker().then(workerId => {
        if (this.taskQueue.length > 0) {
          const task = this.taskQueue.shift()!;
          this.assignTaskToWorker(task, workerId);
        }
      }).catch(err => {
        logger.error('Failed to create additional worker:', err);
      });
    }
  }

  /**
   * Assign a task to a specific worker
   */
  private assignTaskToWorker(task: WorkerTask, workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      logger.error(`Worker ${workerId} not found`);
      this.taskQueue.unshift(task); // Add back to queue
      return;
    }

    this.availableWorkers.delete(workerId);
    this.busyWorkers.add(workerId);

    // Set up task timeout
    const timeoutId = setTimeout(() => {
      const activeTask = this.activeTasks.get(task.id);
      if (activeTask) {
        activeTask.reject(new Error(`Task ${task.id} timed out after ${task.timeout}ms`));
        this.activeTasks.delete(task.id);
        this.busyWorkers.delete(workerId);
        this.availableWorkers.add(workerId);
        
        // Terminate and recreate worker if it's stuck
        worker.terminate().then(() => {
          this.handleWorkerExit(workerId);
        });
      }
    }, task.timeout);

    // Send task to worker
    worker.postMessage(task);

    logger.debug(`Assigned task ${task.id} to worker ${workerId}`);
  }

  /**
   * Submit a task to the worker pool
   */
  async submitTask<T, R>(
    type: string, 
    data: T, 
    options: Partial<{ priority: number; timeout: number; retries: number }> = {}
  ): Promise<R> {
    if (this.isShuttingDown) {
      throw new Error('Worker pool is shutting down');
    }

    if (this.taskQueue.length >= this.config.maxQueueSize) {
      throw new Error('Task queue is full');
    }

    const task: WorkerTask<T> = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      data,
      priority: options.priority || 1,
      timeout: options.timeout || this.config.taskTimeout,
      retries: options.retries || this.config.maxRetries,
      createdAt: Date.now()
    };

    return new Promise<R>((resolve, reject) => {
      // Add to active tasks
      this.activeTasks.set(task.id, {
        task,
        resolve,
        reject,
        startTime: Date.now()
      });

      // Add to queue (sorted by priority)
      this.taskQueue.push(task);
      this.taskQueue.sort((a, b) => b.priority - a.priority);

      // Try to process immediately
      this.processQueue();
    });
  }

  /**
   * Submit multiple tasks in batch
   */
  async submitBatch<T, R>(
    type: string,
    dataArray: T[],
    options: Partial<{ priority: number; timeout: number; retries: number }> = {}
  ): Promise<R[]> {
    const promises = dataArray.map(data => 
      this.submitTask<T, R>(type, data, options)
    );

    return Promise.allSettled(promises).then(results => 
      results.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          logger.error(`Batch task ${index} failed:`, result.reason);
          throw result.reason;
        }
      })
    );
  }

  /**
   * Clean up idle workers
   */
  private cleanupIdleWorkers(): void {
    const now = Date.now();
    const idleTimeout = this.config.idleTimeout;

    // Only clean up if we have more than minimum workers
    if (this.workers.size <= this.config.minWorkers) {
      return;
    }

    const workersToTerminate: string[] = [];
    
    for (const workerId of this.availableWorkers) {
      // In a real implementation, you'd track last activity time
      // For now, we'll keep it simple and not terminate idle workers
      // This is where you'd implement idle worker cleanup logic
    }

    // Terminate idle workers
    workersToTerminate.forEach(workerId => {
      const worker = this.workers.get(workerId);
      if (worker) {
        worker.terminate();
        this.workers.delete(workerId);
        this.availableWorkers.delete(workerId);
        logger.debug(`Terminated idle worker ${workerId}`);
      }
    });
  }

  /**
   * Get worker pool statistics
   */
  getStats(): WorkerPoolStats {
    const avgProcessingTime = this.stats.completedTasks > 0 
      ? this.stats.totalProcessingTime / this.stats.completedTasks 
      : 0;

    return {
      poolSize: this.workers.size,
      activeWorkers: this.busyWorkers.size,
      idleWorkers: this.availableWorkers.size,
      queuedTasks: this.taskQueue.length,
      completedTasks: this.stats.completedTasks,
      failedTasks: this.stats.failedTasks,
      avgProcessingTime: Math.round(avgProcessingTime),
      cpuUsage: process.cpuUsage().user / 1000000, // Convert to seconds
      memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024 // Convert to MB
    };
  }

  /**
   * Get detailed pool information
   */
  getPoolInfo(): {
    config: PoolConfig;
    stats: WorkerPoolStats;
    workers: Array<{ id: string; status: 'idle' | 'busy' }>;
    queueInfo: {
      totalTasks: number;
      highPriorityTasks: number;
      avgWaitTime: number;
    };
  } {
    const stats = this.getStats();
    
    const workers = Array.from(this.workers.keys()).map(id => ({
      id,
      status: this.busyWorkers.has(id) ? 'busy' as const : 'idle' as const
    }));

    const now = Date.now();
    const highPriorityTasks = this.taskQueue.filter(task => task.priority > 5).length;
    const avgWaitTime = this.taskQueue.length > 0
      ? this.taskQueue.reduce((sum, task) => sum + (now - task.createdAt), 0) / this.taskQueue.length
      : 0;

    return {
      config: this.config,
      stats,
      workers,
      queueInfo: {
        totalTasks: this.taskQueue.length,
        highPriorityTasks,
        avgWaitTime: Math.round(avgWaitTime)
      }
    };
  }

  /**
   * Gracefully shutdown the worker pool
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down worker pool...');
    this.isShuttingDown = true;

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Reject all pending tasks
    for (const [taskId, activeTask] of this.activeTasks) {
      activeTask.reject(new Error('Worker pool shutting down'));
    }
    this.activeTasks.clear();

    // Clear task queue
    this.taskQueue.length = 0;

    // Terminate all workers
    const terminationPromises = Array.from(this.workers.values()).map(worker => 
      worker.terminate()
    );

    await Promise.allSettled(terminationPromises);
    
    this.workers.clear();
    this.availableWorkers.clear();
    this.busyWorkers.clear();

    logger.info('Worker pool shutdown completed');
  }
}

// Export singleton instance
export const workerPoolManager = new WorkerPoolManager();