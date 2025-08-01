import { EventEmitter } from 'events';
import { bingxClient } from '../services/bingxClient';
import { apiRequestManager } from '../services/APIRequestManager';
import { QueuedSignal } from './PrioritySignalQueue';
import { PositionManager, ManagedPosition } from './PositionManager';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import Trade from '../models/Trade';

// Import BotConfig interface for validation
interface BotConfig {
  enabled: boolean;
  maxConcurrentTrades: number;
  defaultPositionSize: number;
  scanInterval: number;
  symbolsToScan: string[];
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  minVolumeUSDT: number;
  rsiOversold: number;
  rsiOverbought: number;
  volumeSpikeThreshold: number;
  minSignalStrength: number;
  confirmationRequired: boolean;
  ma1Period: number;
  ma2Period: number;
  riskRewardRatio: number;
  maxDrawdownPercent: number;
  maxDailyLossUSDT: number;
  maxPositionSizePercent: number;
}

// Trade rejection reasons interface
interface TradeRejectionReason {
  code: string;
  message: string;
  details?: any;
}

// Validation result interface
interface ValidationResult {
  isValid: boolean;
  rejectionReason?: TradeRejectionReason;
}

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
  // Add validation config
  validation?: {
    enablePositionSizeValidation: boolean;
    enableRiskRewardValidation: boolean;
    enableBalanceValidation: boolean;
    enableSignalStrengthValidation: boolean;
    notifyRejections: boolean;
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

      // Get smart entry price based on market conditions
      const { price: smartEntryPrice, strategy: entryStrategy } = await this.getSmartEntryPrice(task.symbol, task.action);
      
      // Also get current market price for comparison
      const currentPrice = await this.getCurrentPrice(task.symbol);
      
      // Calculate position details using smart entry price
      const positionDetails = this.calculatePosition(task, smartEntryPrice);
      
      // Log entry strategy
      logger.info(`Using ${entryStrategy} strategy for ${task.symbol}:`, {
        marketPrice: currentPrice,
        smartEntryPrice,
        priceImprovement: ((currentPrice - smartEntryPrice) / currentPrice * 100).toFixed(4) + '%'
      });
      
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

  // Get smart entry price based on market conditions
  private async getSmartEntryPrice(symbol: string, side: 'BUY' | 'SELL'): Promise<{ price: number; strategy: string }> {
    try {
      // Get current market data
      const ticker = await apiRequestManager.getTicker(symbol) as any;
      const depth = await apiRequestManager.getDepth(symbol, 20) as any;
      
      if (!ticker.data || !depth.data) {
        const fallbackPrice = await this.getCurrentPrice(symbol);
        return { price: fallbackPrice, strategy: 'MARKET_FALLBACK' };
      }

      const lastPrice = parseFloat(ticker.data.lastPrice);
      const bidPrice = parseFloat(ticker.data.bidPrice || lastPrice);
      const askPrice = parseFloat(ticker.data.askPrice || lastPrice);
      const spread = askPrice - bidPrice;
      const spreadPercent = (spread / lastPrice) * 100;

      // Analyze order book depth
      const bids = depth.data.bids || [];
      const asks = depth.data.asks || [];
      
      let smartPrice: number;
      let strategy: string;

      if (spreadPercent < 0.01) {
        // Tight spread - use aggressive pricing for better fills
        if (side === 'BUY') {
          // Place bid slightly above best bid but below mid-price
          const bestBid = bids.length > 0 ? parseFloat(bids[0][0]) : bidPrice;
          const midPrice = (bidPrice + askPrice) / 2;
          smartPrice = Math.min(bestBid + (spread * 0.3), midPrice);
          strategy = 'AGGRESSIVE_BID';
        } else {
          // Place ask slightly below best ask but above mid-price
          const bestAsk = asks.length > 0 ? parseFloat(asks[0][0]) : askPrice;
          const midPrice = (bidPrice + askPrice) / 2;
          smartPrice = Math.max(bestAsk - (spread * 0.3), midPrice);
          strategy = 'AGGRESSIVE_ASK';
        }
      } else if (spreadPercent < 0.05) {
        // Medium spread - use market price with slight edge
        const edge = lastPrice * 0.0005; // 0.05% edge
        if (side === 'BUY') {
          smartPrice = lastPrice + edge;
          strategy = 'MARKET_PLUS_EDGE';
        } else {
          smartPrice = lastPrice - edge;
          strategy = 'MARKET_MINUS_EDGE';
        }
      } else {
        // Wide spread - use conservative market pricing
        smartPrice = lastPrice;
        strategy = 'MARKET_CONSERVATIVE';
      }

      // Ensure price is within reasonable bounds (max 0.1% slippage)
      const maxSlippage = lastPrice * 0.001;
      if (side === 'BUY' && smartPrice > lastPrice + maxSlippage) {
        smartPrice = lastPrice + maxSlippage;
        strategy += '_SLIPPAGE_LIMITED';
      } else if (side === 'SELL' && smartPrice < lastPrice - maxSlippage) {
        smartPrice = lastPrice - maxSlippage;
        strategy += '_SLIPPAGE_LIMITED';
      }

      logger.debug(`Smart entry price for ${symbol}:`, {
        side,
        lastPrice,
        smartPrice,
        strategy,
        spread: spread.toFixed(6),
        spreadPercent: spreadPercent.toFixed(4)
      });

      return { price: smartPrice, strategy };

    } catch (error) {
      logger.warn(`Failed to calculate smart entry price for ${symbol}, using market price:`, error);
      const fallbackPrice = await this.getCurrentPrice(symbol);
      return { price: fallbackPrice, strategy: 'MARKET_FALLBACK' };
    }
  }

  private calculatePosition(task: TradeTask, currentPrice: number) {
    const { riskManagement } = this.config;
    
    // DYNAMIC POSITION SIZING: Adapt to symbol-specific limits  
    const safePositionSize = task.positionSize; // Will be validated at queue level
    
    // Calculate quantity based on safe position size
    const quantity = parseFloat((safePositionSize / currentPrice).toFixed(6));
    
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

    const orderResponse = await bingxClient.placeOrder(orderData);
    
    // Check if order was successful
    if (orderResponse.code !== 0) {
      logger.error('Order placement failed:', {
        orderData,
        response: orderResponse,
        code: orderResponse.code,
        message: orderResponse.msg
      });
      throw new Error(`Order placement failed: ${orderResponse.msg || 'Unknown error'}`);
    }

    // Extract orderId from response - check multiple possible locations
    // BingX API typically returns orderId directly in the data field for successful orders
    // Handle both number and string orderId formats from BingX response
    let orderId = orderResponse.data?.orderId || orderResponse.data?.orderID || orderResponse.data?.id;
    
    // Also check root level for orderId (sometimes BingX returns it there)
    if (!orderId) {
      orderId = orderResponse.orderId || orderResponse.orderID || orderResponse.id;
    }
    
    if (!orderId) {
      logger.error('Order response missing orderId:', {
        order: orderResponse.data,
        fullResponse: orderResponse,
        availableFields: orderResponse.data ? Object.keys(orderResponse.data) : 'No data field',
        rootFields: Object.keys(orderResponse),
        message: 'Could not find orderId in expected fields'
      });
      throw new Error('Order response missing orderId');
    }

    // Aguardar confirmação da execução da ordem
    let finalOrderStatus = orderResponse.data?.status || 'NEW';
    let executedQty = orderResponse.data?.executedQty || '0';
    let avgPrice = orderResponse.data?.avgPrice || positionDetails.entryPrice;
    
    // Se a ordem não foi imediatamente executada, aguardar por um curto período
    if (finalOrderStatus === 'NEW' || finalOrderStatus === 'PARTIALLY_FILLED') {
      logger.info(`⏳ Order placed but not filled yet, waiting for execution: ${orderId}`);
      
      // Aguardar até 10 segundos para a execução (orders de mercado geralmente são rápidas)
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Aguardar 1 segundo
        
        try {
          // Verificar status da ordem
          const orderStatus = await bingxClient.getOpenOrders(task.symbol);
          if (orderStatus.code === 0 && orderStatus.data) {
            // Garantir que orderStatus.data é um array
            const ordersArray = Array.isArray(orderStatus.data) ? orderStatus.data : [orderStatus.data];
            
            const currentOrder = ordersArray.find((order: any) => 
              order.orderId === orderId || order.orderId?.toString() === orderId.toString()
            );
            
            if (currentOrder) {
              finalOrderStatus = currentOrder.status;
              executedQty = currentOrder.executedQty || '0';
              avgPrice = currentOrder.avgPrice || avgPrice;
              
              logger.info(`📊 Order status check: ${finalOrderStatus} for ${orderId}`);
              
              if (finalOrderStatus === 'FILLED') {
                logger.info(`✅ Order confirmed as FILLED: ${orderId}`);
                break;
              }
            } else {
              // Ordem não encontrada nas ordens abertas - pode ter sido executada
              logger.info(`🔍 Order not found in open orders, likely filled: ${orderId}`);
              finalOrderStatus = 'FILLED';
              break;
            }
          }
        } catch (statusError) {
          logger.warn(`⚠️ Failed to check order status: ${statusError}`);
        }
      }
    }

    logger.info('✅ Order processing completed:', {
      orderId: orderId.toString(),
      symbol: task.symbol,
      side: task.action,
      finalStatus: finalOrderStatus,
      executedQty: executedQty,
      avgPrice: avgPrice
    });

    return {
      orderId: orderId.toString(), // Ensure it's a string
      symbol: task.symbol,
      side: task.action,
      quantity: positionDetails.quantity,
      price: avgPrice,
      stopLoss: positionDetails.stopLoss,
      takeProfit: positionDetails.takeProfit,
      timestamp: Date.now(),
      orderStatus: finalOrderStatus,
      executedQty: executedQty
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
  private botConfig: BotConfig | null = null;
  private broadcastFunction: ((type: string, data: any) => void) | null = null;
  private dailyLossTracker: { date: string; totalLoss: number } = { date: '', totalLoss: 0 };
  private currentDrawdown: number = 0;
  private peakBalance: number = 0;

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
      validation: {
        enablePositionSizeValidation: true,
        enableRiskRewardValidation: true,
        enableBalanceValidation: true,
        enableSignalStrengthValidation: true,
        notifyRejections: true
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

  async addSignal(queuedSignal: QueuedSignal, positionSize?: number): Promise<string | null> {
    try {
      // Skip HOLD signals early
      if (queuedSignal.signal.action !== 'BUY' && queuedSignal.signal.action !== 'SELL') {
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

      // 🔍 COMPREHENSIVE TRADE VALIDATION
      const validationResult = await this.validateTradeRequest(task);
      if (!validationResult.isValid && validationResult.rejectionReason) {
        this.handleTradeRejection(task, validationResult.rejectionReason);
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

  /**
   * 🔍 COMPREHENSIVE TRADE VALIDATION
   * Validates trade against all BotControls parameters
   */
  private async validateTradeRequest(task: TradeTask): Promise<ValidationResult> {
    if (!this.botConfig || !this.config.validation?.enablePositionSizeValidation) {
      return { isValid: true };
    }

    // 1. Rate limit validation
    if (!this.checkRateLimit()) {
      return {
        isValid: false,
        rejectionReason: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Rate limit exceeded. Maximum trades per second reached.',
          details: { limit: this.config.rateLimit }
        }
      };
    }

    // 2. Concurrent trades validation
    if (this.activePositions.size >= this.botConfig.maxConcurrentTrades) {
      return {
        isValid: false,
        rejectionReason: {
          code: 'MAX_CONCURRENT_TRADES',
          message: `Maximum concurrent trades reached: ${this.activePositions.size}/${this.botConfig.maxConcurrentTrades}`,
          details: { current: this.activePositions.size, max: this.botConfig.maxConcurrentTrades }
        }
      };
    }

    // 3. Existing position validation
    if (this.activePositions.has(task.symbol)) {
      return {
        isValid: false,
        rejectionReason: {
          code: 'POSITION_EXISTS',
          message: `Active position already exists for ${task.symbol}`,
          details: { symbol: task.symbol }
        }
      };
    }

    // 4. Signal strength validation
    if (this.config.validation?.enableSignalStrengthValidation && 
        task.queuedSignal.signal.strength < this.botConfig.minSignalStrength) {
      return {
        isValid: false,
        rejectionReason: {
          code: 'SIGNAL_STRENGTH_LOW',
          message: `Signal strength ${task.queuedSignal.signal.strength}% below minimum ${this.botConfig.minSignalStrength}%`,
          details: { 
            signalStrength: task.queuedSignal.signal.strength, 
            minimumRequired: this.botConfig.minSignalStrength 
          }
        }
      };
    }

    // 5. Position size validation against asset limits
    const assetLimits = this.getAssetLimits(task.symbol);
    if (task.positionSize > assetLimits.maxPositionUSDT) {
      return {
        isValid: false,
        rejectionReason: {
          code: 'POSITION_SIZE_EXCEEDED',
          message: `Position size ${task.positionSize} USDT exceeds asset limit of ${assetLimits.maxPositionUSDT} USDT for ${task.symbol}`,
          details: { 
            requestedSize: task.positionSize, 
            maxAllowed: assetLimits.maxPositionUSDT,
            symbol: task.symbol
          }
        }
      };
    }

    // 6. Account balance validation
    if (this.config.validation?.enableBalanceValidation) {
      try {
        const balanceResponse = await apiRequestManager.getBalance() as any;
        if (balanceResponse.code === 0 && balanceResponse.data) {
          const baseCurrency = process.env.DEMO_MODE === 'true' ? 'VST' : 'USDT';
          let availableBalance = 0;
          
          if (Array.isArray(balanceResponse.data)) {
            const balance = balanceResponse.data.find((b: any) => b.asset === baseCurrency);
            availableBalance = parseFloat(balance?.availableMargin || balance?.balance || '0');
          } else if (balanceResponse.data.balance) {
            availableBalance = parseFloat(balanceResponse.data.balance.availableMargin || 
                                        balanceResponse.data.balance.balance || '0');
          }

          if (availableBalance < task.positionSize) {
            return {
              isValid: false,
              rejectionReason: {
                code: 'INSUFFICIENT_BALANCE',
                message: `Insufficient balance: ${availableBalance.toFixed(2)} ${baseCurrency} < ${task.positionSize} ${baseCurrency}`,
                details: { 
                  availableBalance: availableBalance.toFixed(2), 
                  requiredAmount: task.positionSize,
                  currency: baseCurrency
                }
              }
            };
          }

          // 7. Maximum position size percentage validation
          const positionSizePercent = (task.positionSize / availableBalance) * 100;
          if (positionSizePercent > this.botConfig.maxPositionSizePercent) {
            return {
              isValid: false,
              rejectionReason: {
                code: 'POSITION_SIZE_PERCENT_EXCEEDED',
                message: `Position size ${positionSizePercent.toFixed(1)}% exceeds maximum ${this.botConfig.maxPositionSizePercent}% of account balance`,
                details: { 
                  positionPercent: positionSizePercent.toFixed(1), 
                  maxAllowed: this.botConfig.maxPositionSizePercent,
                  accountBalance: availableBalance.toFixed(2)
                }
              }
            };
          }
        }
      } catch (error) {
        logger.warn('Failed to validate account balance:', error);
      }
    }

    // 8. Risk/Reward ratio validation
    if (this.config.validation?.enableRiskRewardValidation) {
      const riskRewardRatio = this.botConfig.takeProfitPercent / this.botConfig.stopLossPercent;
      if (riskRewardRatio < this.botConfig.riskRewardRatio) {
        return {
          isValid: false,
          rejectionReason: {
            code: 'RISK_REWARD_RATIO_LOW',
            message: `Risk/reward ratio ${riskRewardRatio.toFixed(2)}:1 below minimum ${this.botConfig.riskRewardRatio}:1`,
            details: { 
              currentRatio: riskRewardRatio.toFixed(2), 
              minimumRequired: this.botConfig.riskRewardRatio,
              stopLoss: this.botConfig.stopLossPercent,
              takeProfit: this.botConfig.takeProfitPercent
            }
          }
        };
      }
    }

    // 9. Daily loss limit validation
    const today = new Date().toDateString();
    if (this.dailyLossTracker.date !== today) {
      this.dailyLossTracker = { date: today, totalLoss: 0 };
    }
    
    const potentialLoss = task.positionSize * (this.botConfig.stopLossPercent / 100);
    if (this.dailyLossTracker.totalLoss + potentialLoss > this.botConfig.maxDailyLossUSDT) {
      return {
        isValid: false,
        rejectionReason: {
          code: 'DAILY_LOSS_LIMIT_EXCEEDED',
          message: `Daily loss limit would be exceeded: ${(this.dailyLossTracker.totalLoss + potentialLoss).toFixed(2)} > ${this.botConfig.maxDailyLossUSDT} USDT`,
          details: { 
            currentDailyLoss: this.dailyLossTracker.totalLoss.toFixed(2),
            potentialAdditionalLoss: potentialLoss.toFixed(2),
            dailyLimit: this.botConfig.maxDailyLossUSDT
          }
        }
      };
    }

    return { isValid: true };
  }

  /**
   * 📢 TRADE REJECTION NOTIFICATION SYSTEM
   * Handles rejected trades with clear notifications
   */
  private handleTradeRejection(task: TradeTask, rejectionReason: TradeRejectionReason): void {
    const message = `🚫 Trade Rejected: ${rejectionReason.message}`;
    
    logger.warn(message, {
      symbol: task.symbol,
      action: task.action,
      positionSize: task.positionSize,
      rejectionCode: rejectionReason.code,
      details: rejectionReason.details
    });

    // Send notification via WebSocket if enabled
    if (this.config.validation?.notifyRejections && this.broadcastFunction) {
      this.broadcastFunction('tradeRejected', {
        taskId: task.id,
        symbol: task.symbol,
        action: task.action,
        positionSize: task.positionSize,
        rejectionReason: {
          code: rejectionReason.code,
          message: rejectionReason.message,
          details: rejectionReason.details
        },
        timestamp: Date.now()
      });
    }

    // Emit rejection event
    this.emit('tradeRejected', {
      task,
      rejectionReason,
      timestamp: Date.now()
    });
  }

  
  /**
   * 📊 Asset-specific limits based on market cap and liquidity
   */
  private getAssetLimits(symbol: string): { maxPositionUSDT: number; maxLeverage: number } {
    const baseAsset = symbol.split('-')[0];
    
    // Tier 1: Major assets (BTC, ETH, BNB, etc.)
    const tier1Assets = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOT', 'AVAX', 'MATIC', 'LINK'];
    if (tier1Assets.includes(baseAsset)) {
      return { maxPositionUSDT: 4000, maxLeverage: 20 }; // Higher limits for major assets
    }
    
    // Tier 2: Mid-cap assets  
    const tier2Assets = ['UNI', 'LTC', 'BCH', 'ATOM', 'NEAR', 'FTM', 'ALGO', 'VET', 'ICP', 'APT'];
    if (tier2Assets.includes(baseAsset)) {
      return { maxPositionUSDT: 2000, maxLeverage: 15 };
    }
    
    // Tier 3: DeFi tokens
    const tier3Assets = ['AAVE', 'CRV', 'MKR', 'COMP', 'SNX', 'SUSHI', 'YFI', '1INCH', 'BAL'];
    if (tier3Assets.includes(baseAsset)) {
      return { maxPositionUSDT: 1500, maxLeverage: 10 };
    }
    
    // Tier 4: Meme/small cap (conservative)
    const tier4Assets = ['PEPE', 'SHIB', 'DOGE', 'FLOKI', 'BONK'];
    if (tier4Assets.includes(baseAsset)) {
      return { maxPositionUSDT: 800, maxLeverage: 5 }; // Very conservative
    }
    
    // Default: Unknown assets (very conservative)
    return { maxPositionUSDT: 500, maxLeverage: 3 };
  }
  
  /**
   * 🔍 Get recommended position size for a symbol
   */
  getRecommendedPositionSize(symbol: string, accountBalance: number): number {
    const limits = this.getAssetLimits(symbol);
    const balancePercent = 0.02; // 2% of balance per trade
    
    const balanceBased = accountBalance * balancePercent;
    const limitBased = limits.maxPositionUSDT * 0.6; // 60% of asset limit
    
    return Math.min(balanceBased, limitBased, 200); // Cap at 200 USDT for safety
  }

  updateConfig(newConfig: Partial<TradeExecutorConfig>) {
    this.config = { ...this.config, ...newConfig };
    logger.info('TradeExecutorPool configuration updated');
  }

  /**
   * 🔧 SET BOT CONFIGURATION
   * Updates the bot configuration used for validation
   */
  setBotConfig(botConfig: BotConfig): void {
    this.botConfig = botConfig;
    logger.info('Bot configuration updated for trade validation', {
      maxConcurrentTrades: botConfig.maxConcurrentTrades,
      defaultPositionSize: botConfig.defaultPositionSize,
      minSignalStrength: botConfig.minSignalStrength,
      riskRewardRatio: botConfig.riskRewardRatio
    });
  }

  /**
   * 🌐 SET BROADCAST FUNCTION
   * Sets the broadcast function for notifications
   */
  setBroadcastFunction(broadcastFn: (type: string, data: any) => void): void {
    this.broadcastFunction = broadcastFn;
    logger.info('Broadcast function integrated for trade notifications');
  }

  /**
   * 📊 UPDATE DAILY LOSS TRACKER
   * Updates the daily loss tracker when trades are closed
   */
  updateDailyLoss(lossAmount: number): void {
    const today = new Date().toDateString();
    if (this.dailyLossTracker.date !== today) {
      this.dailyLossTracker = { date: today, totalLoss: 0 };
    }
    
    this.dailyLossTracker.totalLoss += lossAmount;
    
    logger.debug('Daily loss tracker updated', {
      date: today,
      totalLoss: this.dailyLossTracker.totalLoss,
      limit: this.botConfig?.maxDailyLossUSDT || 'Not set'
    });
  }

  /**
   * 📈 GET VALIDATION METRICS
   * Returns validation statistics
   */
  getValidationMetrics(): any {
    return {
      dailyLoss: this.dailyLossTracker,
      currentDrawdown: this.currentDrawdown,
      peakBalance: this.peakBalance,
      validationConfig: this.config.validation,
      botConfig: this.botConfig ? {
        maxConcurrentTrades: this.botConfig.maxConcurrentTrades,
        maxPositionSizePercent: this.botConfig.maxPositionSizePercent,
        minSignalStrength: this.botConfig.minSignalStrength,
        riskRewardRatio: this.botConfig.riskRewardRatio,
        maxDailyLossUSDT: this.botConfig.maxDailyLossUSDT
      } : null
    };
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