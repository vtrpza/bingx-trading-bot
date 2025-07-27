import { EventEmitter } from 'events';
import { bingxClient } from '../services/bingxClient';
import { apiRequestManager } from '../services/APIRequestManager';
import { QueuedSignal } from './PrioritySignalQueue';
import { PositionManager, ManagedPosition } from './PositionManager';
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

  // Helper method to get the base currency (USDT for live, VST for demo)
  private getBaseCurrency(): string {
    return process.env.DEMO_MODE === 'true' ? 'VST' : 'USDT';
  }

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

    // Check account balance using APIRequestManager (priority HIGH for trading)
    const balanceResponse = await apiRequestManager.getBalance() as any;
    if (balanceResponse.code !== 0 || !balanceResponse.data) {
      throw new Error('Unable to fetch account balance');
    }

    // Handle different balance data structures
    let balanceData;
    let usdtBalance;
    
    const baseCurrency = this.getBaseCurrency();
    
    if (Array.isArray(balanceResponse.data)) {
      // Array of balances
      balanceData = balanceResponse.data;
      usdtBalance = balanceData.find((b: any) => b.asset === 'USDT' || b.asset === 'VST' || b.asset === baseCurrency);
    } else if (balanceResponse.data.balance && Array.isArray(balanceResponse.data.balance)) {
      // Nested array in balance property
      balanceData = balanceResponse.data.balance;
      usdtBalance = balanceData.find((b: any) => b.asset === 'USDT' || b.asset === 'VST' || b.asset === baseCurrency);
    } else if (balanceResponse.data.balance && balanceResponse.data.balance.asset) {
      // Single balance object structure
      const balance = balanceResponse.data.balance;
      if (balance.asset === 'USDT' || balance.asset === 'VST' || balance.asset === baseCurrency) {
        // VST is the demo trading currency, treat it like USDT
        usdtBalance = balance;
        if (balance.asset === 'VST') {
          logger.debug('Using VST balance from demo trading environment');
        }
      } else {
        logger.warn(`Single balance returned for ${balance.asset}, expected ${baseCurrency}. Using available balance as reference.`);
        // Assume sufficient balance if we have any balance
        usdtBalance = { asset: balance.asset, balance: balance.balance, availableMargin: balance.availableMargin };
      }
    } else {
      logger.error('Unexpected balance data structure:', balanceResponse.data);
      throw new Error('Invalid balance data structure');
    }

    if (!usdtBalance) {
      logger.error(`${baseCurrency} balance not found in response:`, balanceResponse.data);
      throw new Error(`${baseCurrency} balance not found`);
    }

    const availableBalance = parseFloat(usdtBalance.availableMargin || usdtBalance.balance || '0');
    if (availableBalance < task.positionSize) {
      throw new Error(`Insufficient balance: ${availableBalance} < ${task.positionSize}`);
    }

    // Check if position already exists for this symbol using APIRequestManager
    const positions = await apiRequestManager.getPositions(task.symbol) as any;
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
    const ticker = await apiRequestManager.getTicker(symbol) as any;
    
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
      logger.error('Order placement failed:', {
        orderData,
        response: order,
        code: order.code,
        message: order.msg
      });
      throw new Error(`Order placement failed: ${order.msg || 'Unknown error'}`);
    }

    if (!order.data.orderId) {
      logger.error('Order response missing orderId:', order.data);
      throw new Error('Order response missing orderId');
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
      // Ensure we have a valid orderId before saving
      if (!orderResult.orderId) {
        logger.error('Cannot save trade without orderId', { orderResult, task: task.symbol });
        throw new Error('Order execution failed - no orderId returned');
      }

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
  private positionManager: PositionManager | null = null;

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
        
        // Add to position manager for active monitoring
        if (this.positionManager) {
          this.addToPositionManager(result);
        }
        
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
    // Immediate processing for faster execution
    setImmediate(() => this.processQueuedTasks());
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

  // PositionManager integration
  setPositionManager(positionManager: PositionManager): void {
    this.positionManager = positionManager;
    
    // Listen for position removals to update our tracking
    this.positionManager.on('positionRemoved', ({ position }) => {
      this.activePositions.delete(position.symbol);
      logger.debug(`Position tracking removed for ${position.symbol}`);
    });
    
    logger.info('PositionManager integrated with TradeExecutorPool');
  }

  private async addToPositionManager(result: any): Promise<void> {
    if (!this.positionManager) return;

    try {
      const { task, result: orderResult, tradeRecord } = result;
      
      // Calculate stop loss and take profit prices
      const stopLossPercent = this.config.riskManagement.stopLossPercent;
      const takeProfitPercent = this.config.riskManagement.takeProfitPercent;
      
      const stopLossPrice = task.action === 'BUY'
        ? orderResult.price * (1 - stopLossPercent / 100)
        : orderResult.price * (1 + stopLossPercent / 100);
        
      const takeProfitPrice = task.action === 'BUY'
        ? orderResult.price * (1 + takeProfitPercent / 100)
        : orderResult.price * (1 - takeProfitPercent / 100);

      const managedPosition: Omit<ManagedPosition, 'id' | 'status' | 'createdAt' | 'lastUpdate'> = {
        symbol: task.symbol,
        side: task.action === 'BUY' ? 'LONG' : 'SHORT',
        entryPrice: orderResult.price,
        quantity: orderResult.quantity,
        stopLossPrice: parseFloat(stopLossPrice.toFixed(6)),
        takeProfitPrice: parseFloat(takeProfitPrice.toFixed(6)),
        orderId: orderResult.orderId,
        tradeId: tradeRecord?.id?.toString(),
        unrealizedPnl: 0
      };

      await this.positionManager.addPosition(managedPosition);
      
      logger.info(`Position added to manager: ${task.symbol}`, {
        orderId: orderResult.orderId,
        stopLoss: managedPosition.stopLossPrice,
        takeProfit: managedPosition.takeProfitPrice
      });
      
    } catch (error) {
      logger.error('Failed to add position to manager:', error);
    }
  }

  // Immediate execution method for high-priority signals
  async executeImmediately(queuedSignal: QueuedSignal, positionSize?: number): Promise<string | null> {
    try {
      // Find an available executor
      const availableExecutor = Array.from(this.executors.values())
        .find(executor => executor.isAvailable());

      if (!availableExecutor) {
        // If no executor available, add to queue with high priority
        return this.addSignal(queuedSignal, positionSize);
      }

      // Check rate limit and position limits
      if (!this.checkRateLimit()) {
        logger.warn('Rate limit exceeded for immediate execution');
        return null;
      }

      if (this.activePositions.size >= this.config.maxConcurrentTrades) {
        logger.warn('Max concurrent trades reached for immediate execution');
        return null;
      }

      if (this.activePositions.has(queuedSignal.signal.symbol)) {
        logger.debug(`Position already exists for ${queuedSignal.signal.symbol}, skipping immediate execution`);
        return null;
      }

      // Create and execute task immediately
      const task: TradeTask = {
        id: uuidv4(),
        queuedSignal,
        symbol: queuedSignal.signal.symbol,
        action: queuedSignal.signal.action as 'BUY' | 'SELL',
        positionSize: positionSize || this.config.positionSizing.defaultSize,
        maxSlippage: this.config.slippageTolerance,
        timestamp: Date.now(),
        priority: 10, // High priority for immediate execution
        attempts: 0,
        maxAttempts: this.config.retryAttempts
      };

      // Skip HOLD signals
      if (task.action !== 'BUY' && task.action !== 'SELL') {
        return null;
      }

      logger.info(`Executing trade immediately: ${task.symbol}`, {
        action: task.action,
        strength: queuedSignal.signal.strength
      });

      // Execute immediately without queueing
      this.processTask(availableExecutor, task);
      
      return task.id;
      
    } catch (error) {
      logger.error('Error in immediate execution:', error);
      return null;
    }
  }
}