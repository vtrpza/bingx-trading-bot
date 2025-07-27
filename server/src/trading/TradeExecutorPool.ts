import { EventEmitter } from 'events';
import { bingxClient } from '../services/bingxClient';
import { QueuedSignal } from './PrioritySignalQueue';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import Trade from '../models/Trade';

export interface TradeTask {
  id: string;
  queuedSignal: QueuedSignal;
  symbol: string;
  action: 'BUY' | 'SELL';
  positionSize: number;
  maxSlippage: number;
  stopLoss?: number;
  takeProfit?: number;
  timestamp: number;
  priority: number;
  attempts: number;
  maxAttempts: number;
}

export interface ExecutorMetrics {
  totalExecuted: number;
  successCount: number;
  failedCount: number;
  avgExecutionTime: number;
  totalVolume: number;
  totalPnL: number;
  lastExecutedAt: number;
}

export interface TradeExecutorConfig {
  maxExecutors: number;
  maxConcurrentTrades: number;
  executionTimeout: number;
  retryAttempts: number;
  rateLimit: number; // trades per second
  slippageTolerance: number;
  positionSizing: {
    defaultSize: number;
    maxPositionSize: number;
    riskPerTrade: number;
  };
  riskManagement: {
    stopLossPercent: number;
    takeProfitPercent: number;
    maxDrawdown: number;
    maxDailyLoss: number;
  };
}

class TradeExecutor extends EventEmitter {
  private id: string;
  private isActive: boolean = false;
  private currentTask: TradeTask | null = null;
  private metrics: ExecutorMetrics;
  private config: TradeExecutorConfig;

  constructor(id: string, config: TradeExecutorConfig) {
    super();
    this.id = id;
    this.config = config;
    this.metrics = {
      totalExecuted: 0,
      successCount: 0,
      failedCount: 0,
      avgExecutionTime: 0,
      totalVolume: 0,
      totalPnL: 0,
      lastExecutedAt: 0
    };
  }

  async executeTask(task: TradeTask): Promise<any> {
    if (this.isActive) {
      throw new Error(`Executor ${this.id} is already processing a task`);
    }

    this.isActive = true;
    this.currentTask = task;
    const startTime = Date.now();

    try {
      logger.info(`Executor ${this.id} executing ${task.action} for ${task.symbol}`, {
        taskId: task.id,
        strength: task.queuedSignal.signal.strength,
        positionSize: task.positionSize
      });

      // Pre-execution validation
      await this.validateTradeConditions(task);

      // Get current market price
      const currentPrice = await this.getCurrentPrice(task.symbol);
      
      // Calculate position details
      const positionDetails = this.calculatePosition(task, currentPrice);
      
      // Execute the trade
      const orderResult = await this.placeOrder(task, positionDetails);
      
      // Save trade to database
      const tradeRecord = await this.saveTrade(task, orderResult, positionDetails);
      
      // Update metrics
      const executionTime = Date.now() - startTime;
      this.updateMetrics(true, executionTime, positionDetails.quantity * currentPrice);
      
      logger.info(`Trade executed successfully by ${this.id}`, {
        orderId: orderResult.orderId,
        symbol: task.symbol,
        price: currentPrice,
        executionTime
      });

      this.emit('tradeExecuted', {
        executorId: this.id,
        task,
        result: orderResult,
        tradeRecord,
        executionTime
      });

      return orderResult;

    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.updateMetrics(false, executionTime, 0);
      
      logger.error(`Trade execution failed in ${this.id}:`, {
        symbol: task.symbol,
        error: error instanceof Error ? error.message : String(error),
        executionTime
      });
      
      this.emit('tradeError', {
        executorId: this.id,
        task,
        error: error instanceof Error ? error.message : String(error),
        executionTime
      });

      throw error;
    } finally {
      this.isActive = false;
      this.currentTask = null;
    }
  }

  private async validateTradeConditions(task: TradeTask): Promise<void> {
    // Check if signal is still valid (not too old)
    const signalAge = Date.now() - task.queuedSignal.signal.timestamp.getTime();
    if (signalAge > 60000) { // 1 minute
      throw new Error('Signal too old for execution');
    }

    // Check account balance
    const balance = await bingxClient.getBalance();
    if (!balance.data || balance.data.length === 0) {
      throw new Error('Unable to fetch account balance');
    }

    const usdtBalance = balance.data.find((b: any) => b.asset === 'USDT');
    if (!usdtBalance || parseFloat(usdtBalance.balance) < task.positionSize) {
      throw new Error('Insufficient USDT balance');
    }

    // Check if position already exists for this symbol
    const positions = await bingxClient.getPositions(task.symbol);
    if (positions.data && positions.data.length > 0) {
      const existingPosition = positions.data.find((p: any) => 
        p.symbol === task.symbol && Math.abs(parseFloat(p.positionAmt)) > 0
      );
      
      if (existingPosition) {
        throw new Error('Position already exists for this symbol');
      }
    }
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    const ticker = await bingxClient.getTicker(symbol);
    
    if (!ticker.data || !ticker.data.lastPrice) {
      throw new Error('Unable to fetch current price');
    }

    return parseFloat(ticker.data.lastPrice);
  }

  private calculatePosition(task: TradeTask, currentPrice: number) {
    const { riskManagement } = this.config;
    
    // Calculate quantity based on position size
    const quantity = parseFloat((task.positionSize / currentPrice).toFixed(6));
    
    // Calculate stop loss and take profit
    const stopLossPrice = task.action === 'BUY'
      ? currentPrice * (1 - riskManagement.stopLossPercent / 100)
      : currentPrice * (1 + riskManagement.stopLossPercent / 100);
      
    const takeProfitPrice = task.action === 'BUY'
      ? currentPrice * (1 + riskManagement.takeProfitPercent / 100)
      : currentPrice * (1 - riskManagement.takeProfitPercent / 100);

    return {
      quantity,
      entryPrice: currentPrice,
      stopLoss: parseFloat(stopLossPrice.toFixed(6)),
      takeProfit: parseFloat(takeProfitPrice.toFixed(6)),
      positionSide: task.action === 'BUY' ? 'LONG' : 'SHORT' as 'LONG' | 'SHORT'
    };
  }

  private async placeOrder(task: TradeTask, positionDetails: any) {
    const orderData = {
      symbol: task.symbol,
      side: task.action,
      positionSide: positionDetails.positionSide,
      type: 'MARKET' as const,
      quantity: positionDetails.quantity,
      stopLoss: positionDetails.stopLoss,
      takeProfit: positionDetails.takeProfit
    };

    const order = await bingxClient.placeOrder(orderData);
    
    if (!order.data || order.code !== 0) {
      throw new Error(`Order placement failed: ${order.msg || 'Unknown error'}`);
    }

    return {
      orderId: order.data.orderId,
      symbol: task.symbol,
      side: task.action,
      quantity: positionDetails.quantity,
      price: positionDetails.entryPrice,
      stopLoss: positionDetails.stopLoss,
      takeProfit: positionDetails.takeProfit,
      timestamp: Date.now()
    };
  }

  private async saveTrade(task: TradeTask, orderResult: any, positionDetails: any) {
    try {
      const tradeRecord = await Trade.create({
        orderId: orderResult.orderId,
        symbol: task.symbol,
        side: task.action,
        positionSide: positionDetails.positionSide,
        type: 'MARKET',
        status: 'NEW',
        quantity: positionDetails.quantity,
        price: positionDetails.entryPrice,
        stopLossPrice: positionDetails.stopLoss,
        takeProfitPrice: positionDetails.takeProfit,
        signalStrength: task.queuedSignal.signal.strength,
        signalReason: task.queuedSignal.signal.reason,
        indicators: task.queuedSignal.signal.indicators,
        commissionAsset: 'USDT',
        commission: 0,
        executedQty: 0,
        avgPrice: 0,
        realizedPnl: 0
      });

      return tradeRecord;
    } catch (error) {
      logger.error('Failed to save trade to database:', error);
      // Don't throw here - trade was executed successfully
      return null;
    }
  }

  private updateMetrics(success: boolean, executionTime: number, volume: number) {
    this.metrics.totalExecuted++;
    
    if (success) {
      this.metrics.successCount++;
      this.metrics.totalVolume += volume;
    } else {
      this.metrics.failedCount++;
    }

    // Update average execution time
    if (this.metrics.avgExecutionTime === 0) {
      this.metrics.avgExecutionTime = executionTime;
    } else {
      this.metrics.avgExecutionTime = 
        (this.metrics.avgExecutionTime + executionTime) / 2;
    }

    this.metrics.lastExecutedAt = Date.now();
  }

  isAvailable(): boolean {
    return !this.isActive;
  }

  getId(): string {
    return this.id;
  }

  getMetrics(): ExecutorMetrics {
    return { ...this.metrics };
  }

  getCurrentTask(): TradeTask | null {
    return this.currentTask;
  }
}

export class TradeExecutorPool extends EventEmitter {
  private executors: Map<string, TradeExecutor> = new Map();
  private taskQueue: TradeTask[] = [];
  private config: TradeExecutorConfig;
  private isRunning: boolean = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private activePositions: Set<string> = new Set();
  private rateLimit: { count: number; windowStart: number } = { count: 0, windowStart: Date.now() };

  constructor(config: Partial<TradeExecutorConfig> = {}) {
    super();
    
    this.config = {
      maxExecutors: 3,
      maxConcurrentTrades: 5,
      executionTimeout: 10000,
      retryAttempts: 2,
      rateLimit: 0.8, // Reduced to respect global 100 req/10s limit
      slippageTolerance: 0.5,
      positionSizing: {
        defaultSize: 100,
        maxPositionSize: 1000,
        riskPerTrade: 2
      },
      riskManagement: {
        stopLossPercent: 2,
        takeProfitPercent: 3,
        maxDrawdown: 10,
        maxDailyLoss: 500
      },
      ...config
    };

    this.initializeExecutors();
  }

  private initializeExecutors() {
    for (let i = 0; i < this.config.maxExecutors; i++) {
      const executorId = `executor-${i}`;
      const executor = new TradeExecutor(executorId, this.config);
      
      executor.on('tradeExecuted', (result) => {
        this.activePositions.add(result.task.symbol);
        this.emit('tradeExecuted', result);
        this.processNextTask();
      });
      
      executor.on('tradeError', (error) => {
        this.handleTaskError(error.task, error.error);
        this.processNextTask();
      });
      
      this.executors.set(executorId, executor);
    }

    logger.info(`TradeExecutorPool initialized with ${this.config.maxExecutors} executors`);
  }

  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.processingInterval = setInterval(() => {
      this.processQueuedTasks();
    }, 100);

    logger.info('TradeExecutorPool started');
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

    this.taskQueue = [];
    
    logger.info('TradeExecutorPool stopped');
  }

  addSignal(queuedSignal: QueuedSignal, positionSize?: number): string | null {
    try {
      // Check rate limit
      if (!this.checkRateLimit()) {
        logger.warn('Rate limit exceeded, skipping trade execution');
        return null;
      }

      // Check concurrent trades limit
      if (this.activePositions.size >= this.config.maxConcurrentTrades) {
        logger.warn('Max concurrent trades reached, skipping execution');
        return null;
      }

      // Check if already have position for this symbol
      if (this.activePositions.has(queuedSignal.signal.symbol)) {
        logger.debug(`Position already exists for ${queuedSignal.signal.symbol}, skipping`);
        return null;
      }

      const task: TradeTask = {
        id: uuidv4(),
        queuedSignal,
        symbol: queuedSignal.signal.symbol,
        action: queuedSignal.signal.action as 'BUY' | 'SELL',
        positionSize: positionSize || this.config.positionSizing.defaultSize,
        maxSlippage: this.config.slippageTolerance,
        timestamp: Date.now(),
        priority: queuedSignal.priority,
        attempts: 0,
        maxAttempts: this.config.retryAttempts
      };

      // Skip HOLD signals
      if (task.action !== 'BUY' && task.action !== 'SELL') {
        return null;
      }

      this.taskQueue.push(task);
      
      // Sort by priority
      this.taskQueue.sort((a, b) => b.priority - a.priority);

      logger.debug(`Trade task queued for ${task.symbol}`, {
        taskId: task.id,
        action: task.action,
        strength: queuedSignal.signal.strength
      });

      this.processQueuedTasks();
      
      return task.id;
      
    } catch (error) {
      logger.error('Error adding signal to executor pool:', error);
      return null;
    }
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowSize = 1000; // 1 second
    
    if (now - this.rateLimit.windowStart > windowSize) {
      this.rateLimit.count = 0;
      this.rateLimit.windowStart = now;
    }
    
    if (this.rateLimit.count >= this.config.rateLimit) {
      return false;
    }
    
    this.rateLimit.count++;
    return true;
  }

  private processQueuedTasks() {
    if (!this.isRunning || this.taskQueue.length === 0) {
      return;
    }

    const availableExecutors = Array.from(this.executors.values())
      .filter(executor => executor.isAvailable());

    if (availableExecutors.length === 0) {
      return;
    }

    const tasksToProcess = this.taskQueue.splice(0, availableExecutors.length);

    for (let i = 0; i < tasksToProcess.length && i < availableExecutors.length; i++) {
      const task = tasksToProcess[i];
      const executor = availableExecutors[i];
      
      this.processTask(executor, task);
    }
  }

  private async processTask(executor: TradeExecutor, task: TradeTask) {
    try {
      await Promise.race([
        executor.executeTask(task),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Execution timeout')), this.config.executionTimeout)
        )
      ]);
    } catch (error) {
      this.handleTaskError(task, error instanceof Error ? error.message : String(error));
    }
  }

  private processNextTask() {
    setTimeout(() => this.processQueuedTasks(), 50);
  }

  private handleTaskError(task: TradeTask, error: string) {
    if (task.attempts < task.maxAttempts) {
      task.attempts++;
      task.timestamp = Date.now();
      this.taskQueue.unshift(task); // Add to front for retry
      
      logger.debug(`Retrying task ${task.id} for ${task.symbol} (attempt ${task.attempts})`);
    } else {
      logger.error(`Task ${task.id} for ${task.symbol} failed permanently: ${error}`);
      
      this.emit('taskFailed', {
        task,
        error,
        finalAttempt: true
      });
    }
  }

  removePosition(symbol: string): void {
    this.activePositions.delete(symbol);
    logger.debug(`Removed position tracking for ${symbol}`);
  }

  getStatus() {
    const executorMetrics = Array.from(this.executors.values()).map(executor => ({
      id: executor.getId(),
      isAvailable: executor.isAvailable(),
      currentTask: executor.getCurrentTask(),
      metrics: executor.getMetrics()
    }));

    return {
      isRunning: this.isRunning,
      queueLength: this.taskQueue.length,
      executors: executorMetrics,
      activePositions: Array.from(this.activePositions),
      config: this.config,
      totalExecutors: this.executors.size,
      availableExecutors: executorMetrics.filter(e => e.isAvailable).length,
      activeExecutors: executorMetrics.filter(e => !e.isAvailable).length
    };
  }

  getMetrics() {
    const executorMetrics = Array.from(this.executors.values()).map(e => e.getMetrics());
    
    const totalExecuted = executorMetrics.reduce((sum, m) => sum + m.totalExecuted, 0);
    const totalSuccess = executorMetrics.reduce((sum, m) => sum + m.successCount, 0);
    const totalFailed = executorMetrics.reduce((sum, m) => sum + m.failedCount, 0);
    const totalVolume = executorMetrics.reduce((sum, m) => sum + m.totalVolume, 0);
    const avgExecutionTime = executorMetrics.length > 0 
      ? executorMetrics.reduce((sum, m) => sum + m.avgExecutionTime, 0) / executorMetrics.length
      : 0;

    return {
      totalExecuted,
      successRate: totalExecuted > 0 ? (totalSuccess / totalExecuted) * 100 : 0,
      failureRate: totalExecuted > 0 ? (totalFailed / totalExecuted) * 100 : 0,
      totalVolume,
      avgExecutionTime,
      queueLength: this.taskQueue.length,
      activePositions: this.activePositions.size,
      activeExecutors: executorMetrics.filter(m => m.lastExecutedAt > Date.now() - 10000).length
    };
  }

  updateConfig(newConfig: Partial<TradeExecutorConfig>) {
    this.config = { ...this.config, ...newConfig };
    logger.info('TradeExecutorPool configuration updated');
  }
}