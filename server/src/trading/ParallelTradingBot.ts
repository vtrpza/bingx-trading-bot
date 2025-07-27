import { EventEmitter } from 'events';
import { SignalWorkerPool, SignalWorkerConfig } from './SignalWorkerPool';
import { PrioritySignalQueue, SignalQueueConfig } from './PrioritySignalQueue';
import { TradeExecutorPool, TradeExecutorConfig } from './TradeExecutorPool';
import { MarketDataCache, MarketDataCacheConfig } from './MarketDataCache';
import { bingxClient } from '../services/bingxClient';
import { wsManager } from '../services/websocket';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import Trade from '../models/Trade';

export interface ParallelBotConfig {
  enabled: boolean;
  scanInterval: number;
  symbolsToScan: string[];
  maxConcurrentTrades: number;
  defaultPositionSize: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  minVolumeUSDT: number;
  
  // Signal generation parameters
  rsiOversold: number;
  rsiOverbought: number;
  volumeSpikeThreshold: number;
  minSignalStrength: number;
  confirmationRequired: boolean;
  ma1Period: number;
  ma2Period: number;
  
  // Parallel processing configuration
  signalWorkers: Partial<SignalWorkerConfig>;
  signalQueue: Partial<SignalQueueConfig>;
  tradeExecutors: Partial<TradeExecutorConfig>;
  marketDataCache: Partial<MarketDataCacheConfig>;
}

export interface ParallelBotMetrics {
  scanningMetrics: {
    totalScans: number;
    avgScanTime: number;
    symbolsPerSecond: number;
    lastScanAt: number;
  };
  signalMetrics: {
    totalGenerated: number;
    queuedSignals: number;
    processedSignals: number;
    avgSignalLatency: number;
  };
  executionMetrics: {
    totalExecuted: number;
    successRate: number;
    avgExecutionTime: number;
    totalVolume: number;
  };
  systemMetrics: {
    workerUtilization: number;
    cacheHitRate: number;
    memoryUsage: number;
    throughput: number;
  };
}

export interface ActivityEvent {
  id: string;
  type: 'scan_started' | 'signal_generated' | 'trade_executed' | 'error' | 'position_closed' | 'market_data_updated';
  symbol?: string;
  message: string;
  timestamp: number;
  level: 'info' | 'warning' | 'error' | 'success';
  metadata?: any;
}

export interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  unrealizedPnl: number;
  orderId: string;
}

export class ParallelTradingBot extends EventEmitter {
  private config: ParallelBotConfig;
  private isRunning: boolean = false;
  private scanInterval: NodeJS.Timeout | null = null;
  
  // Core components
  private signalWorkerPool!: SignalWorkerPool;
  private signalQueue!: PrioritySignalQueue;
  private tradeExecutorPool!: TradeExecutorPool;
  private marketDataCache!: MarketDataCache;
  
  // State tracking
  private activePositions: Map<string, Position> = new Map();
  private activityEvents: ActivityEvent[] = [];
  private metrics!: ParallelBotMetrics;
  private scanStartTime: number = 0;
  private totalScans: number = 0;

  constructor(config?: Partial<ParallelBotConfig>) {
    super();
    
    this.config = {
      enabled: false,
      scanInterval: 30000, // 30 seconds
      symbolsToScan: [],
      maxConcurrentTrades: 5,
      defaultPositionSize: 100,
      stopLossPercent: 2,
      takeProfitPercent: 3,
      minVolumeUSDT: 100000,
      
      // Signal parameters
      rsiOversold: 30,
      rsiOverbought: 70,
      volumeSpikeThreshold: 1.5,
      minSignalStrength: 65,
      confirmationRequired: true,
      ma1Period: 9,
      ma2Period: 21,
      
      // Component configurations
      signalWorkers: {
        maxWorkers: 5,
        maxConcurrentTasks: 15,
        taskTimeout: 6000,
        retryAttempts: 2,
        batchSize: 5
      },
      signalQueue: {
        maxSize: 100,
        defaultTTL: 30000,
        maxAttempts: 3,
        deduplicationWindow: 60000
      },
      tradeExecutors: {
        maxExecutors: 3,
        maxConcurrentTrades: 5,
        executionTimeout: 10000,
        retryAttempts: 2,
        rateLimit: 2
      },
      marketDataCache: {
        tickerCacheTTL: 5000,
        klineCacheTTL: 30000,
        maxCacheSize: 100,
        priceChangeThreshold: 0.1
      },
      
      ...config
    };

    this.initializeMetrics();
    this.initializeComponents();
    this.setupEventHandlers();
    this.setupWebSocketListeners();
  }

  private initializeMetrics(): void {
    this.metrics = {
      scanningMetrics: {
        totalScans: 0,
        avgScanTime: 0,
        symbolsPerSecond: 0,
        lastScanAt: 0
      },
      signalMetrics: {
        totalGenerated: 0,
        queuedSignals: 0,
        processedSignals: 0,
        avgSignalLatency: 0
      },
      executionMetrics: {
        totalExecuted: 0,
        successRate: 0,
        avgExecutionTime: 0,
        totalVolume: 0
      },
      systemMetrics: {
        workerUtilization: 0,
        cacheHitRate: 0,
        memoryUsage: 0,
        throughput: 0
      }
    };
  }

  private initializeComponents(): void {
    // Initialize market data cache first
    this.marketDataCache = new MarketDataCache(this.config.marketDataCache);
    
    // Initialize signal worker pool with proper signal config
    const signalConfig = {
      rsiOversold: this.config.rsiOversold,
      rsiOverbought: this.config.rsiOverbought,
      volumeSpikeThreshold: this.config.volumeSpikeThreshold,
      minSignalStrength: this.config.minSignalStrength,
      confirmationRequired: this.config.confirmationRequired
    };
    
    this.signalWorkerPool = new SignalWorkerPool({
      ...this.config.signalWorkers,
      signalConfig
    });
    
    // Initialize signal queue
    this.signalQueue = new PrioritySignalQueue(this.config.signalQueue);
    
    // Initialize trade executor pool
    this.tradeExecutorPool = new TradeExecutorPool({
      ...this.config.tradeExecutors,
      maxConcurrentTrades: this.config.maxConcurrentTrades,
      positionSizing: {
        defaultSize: this.config.defaultPositionSize,
        maxPositionSize: this.config.defaultPositionSize * 10,
        riskPerTrade: 2
      },
      riskManagement: {
        stopLossPercent: this.config.stopLossPercent,
        takeProfitPercent: this.config.takeProfitPercent,
        maxDrawdown: 10,
        maxDailyLoss: 500
      }
    });
  }

  private setupEventHandlers(): void {
    // Signal worker pool events
    this.signalWorkerPool.on('signalGenerated', (signal) => {
      this.handleSignalGenerated(signal);
    });

    this.signalWorkerPool.on('taskFailed', (error) => {
      this.addActivityEvent('error', `Signal generation failed: ${error.error}`, 'error', error.task.symbol);
    });

    // Signal queue events
    this.signalQueue.on('signalQueued', (queuedSignal) => {
      this.metrics.signalMetrics.queuedSignals++;
      this.addActivityEvent('signal_generated', 
        `Signal queued: ${queuedSignal.signal.action} ${queuedSignal.signal.symbol} (${queuedSignal.signal.strength}%)`,
        'info', 
        queuedSignal.signal.symbol,
        { priority: queuedSignal.priority }
      );
    });

    this.signalQueue.on('signalDequeued', (queuedSignal) => {
      this.metrics.signalMetrics.processedSignals++;
      // Send to trade executor
      this.tradeExecutorPool.addSignal(queuedSignal, this.config.defaultPositionSize);
    });

    this.signalQueue.on('signalExpired', (queuedSignal) => {
      this.addActivityEvent('error', 
        `Signal expired: ${queuedSignal.signal.symbol}`,
        'warning', 
        queuedSignal.signal.symbol
      );
    });

    // Trade executor pool events
    this.tradeExecutorPool.on('tradeExecuted', (result) => {
      this.handleTradeExecuted(result);
    });

    this.tradeExecutorPool.on('taskFailed', (error) => {
      this.addActivityEvent('error', `Trade execution failed: ${error.error}`, 'error', error.task.symbol);
    });

    // Market data cache events
    this.marketDataCache.on('significantPriceChange', (change) => {
      this.addActivityEvent('market_data_updated', 
        `Significant price change: ${change.symbol} ${change.changePercent.toFixed(2)}%`,
        'info',
        change.symbol
      );
    });
  }

  private setupWebSocketListeners(): void {
    wsManager.on('orderUpdate', (data) => {
      this.handleOrderUpdate(data);
    });

    wsManager.on('accountUpdate', (data) => {
      this.handleAccountUpdate(data);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Parallel Trading Bot is already running');
      return;
    }

    logger.info('Starting Parallel Trading Bot...');
    
    try {
      this.isRunning = true;
      this.emit('started');

      // Start all components
      this.marketDataCache.start();
      this.signalWorkerPool.start();
      this.tradeExecutorPool.start();

      // Load active positions
      await this.loadActivePositions();

      // Update symbol list and preload market data
      await this.updateSymbolList();
      
      // Start scanning
      this.startScanning();
      
      this.addActivityEvent('scan_started', 
        `Bot started successfully. Scanning ${this.config.symbolsToScan.length} symbols every ${this.config.scanInterval}ms`,
        'success'
      );
      
      logger.info(`Parallel Trading Bot started successfully`);
    } catch (error) {
      logger.error('Failed to start Parallel Trading Bot:', error);
      this.isRunning = false;
      throw error;
    }
  }

  stop(): void {
    if (!this.isRunning) {
      logger.warn('Parallel Trading Bot is already stopped');
      return;
    }

    logger.info('Stopping Parallel Trading Bot...');
    this.isRunning = false;

    // Stop scanning
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    // Stop all components
    this.signalWorkerPool.stop();
    this.signalQueue.clear();
    this.tradeExecutorPool.stop();
    this.marketDataCache.stop();

    this.emit('stopped');
    this.addActivityEvent('scan_started', 'Bot stopped successfully', 'info');
    
    logger.info('Parallel Trading Bot stopped successfully');
  }

  private async updateSymbolList(): Promise<void> {
    try {
      // Use predefined popular symbols for immediate start
      const baseSymbols = [
        'BTC-USDT', 'ETH-USDT', 'BNB-USDT', 'SOL-USDT', 'XRP-USDT',
        'ADA-USDT', 'DOGE-USDT', 'DOT-USDT', 'MATIC-USDT', 'AVAX-USDT',
        'LINK-USDT', 'UNI-USDT', 'LTC-USDT', 'BCH-USDT', 'ATOM-USDT'
      ];

      // Convert to VST symbols if in demo mode
      const popularSymbols = process.env.DEMO_MODE === 'true' 
        ? baseSymbols.map(symbol => symbol.replace('-USDT', '-VST'))
        : baseSymbols;

      this.config.symbolsToScan = popularSymbols;
      
      // Preload market data for faster processing
      await this.marketDataCache.preloadSymbols(popularSymbols);
      
      logger.info(`Symbol list updated with ${popularSymbols.length} symbols`, {
        demoMode: process.env.DEMO_MODE === 'true',
        sampleSymbols: popularSymbols.slice(0, 3)
      });
    } catch (error) {
      logger.error('Failed to update symbol list:', error);
    }
  }

  private startScanning(): void {
    // Initial scan
    this.scanSymbols();

    // Set up interval
    this.scanInterval = setInterval(() => {
      if (this.isRunning) {
        this.scanSymbols();
      }
    }, this.config.scanInterval);
  }

  private async scanSymbols(): Promise<void> {
    if (this.activePositions.size >= this.config.maxConcurrentTrades) {
      logger.debug('Max concurrent trades reached, skipping scan');
      return;
    }

    const symbolsToScan = this.config.symbolsToScan.filter(symbol => 
      !this.activePositions.has(symbol)
    );

    if (symbolsToScan.length === 0) {
      logger.debug('No new symbols to scan');
      return;
    }

    this.scanStartTime = Date.now();
    this.totalScans++;

    logger.debug(`Starting parallel scan of ${symbolsToScan.length} symbols`);
    this.addActivityEvent('scan_started', 
      `Starting scan of ${symbolsToScan.length} symbols`, 
      'info'
    );

    // Add symbols to worker pool for parallel processing
    const taskIds = this.signalWorkerPool.addSymbols(symbolsToScan, 1);
    
    // Update metrics
    this.updateScanMetrics(symbolsToScan.length);
    
    logger.debug(`Added ${taskIds.length} symbols to worker pool for processing`);
  }

  private handleSignalGenerated(signal: any): void {
    this.metrics.signalMetrics.totalGenerated++;
    
    // Only queue signals that are actionable
    if (signal.action !== 'HOLD' && signal.strength >= this.config.minSignalStrength) {
      const queuedId = this.signalQueue.enqueue(signal);
      
      if (queuedId) {
        // Process next signal from queue
        this.processSignalQueue();
      }
    }
  }

  private processSignalQueue(): void {
    // Process signals from queue
    const queuedSignal = this.signalQueue.dequeue();
    
    if (queuedSignal) {
      // Signal is automatically sent to trade executor via event handler
      logger.debug(`Processing signal for ${queuedSignal.signal.symbol}`);
    }
  }

  private handleTradeExecuted(result: any): void {
    const { task, result: orderResult } = result;
    
    // Add to active positions
    this.activePositions.set(task.symbol, {
      symbol: task.symbol,
      side: task.action === 'BUY' ? 'LONG' : 'SHORT',
      entryPrice: orderResult.price,
      quantity: orderResult.quantity,
      unrealizedPnl: 0,
      orderId: orderResult.orderId
    });

    // Update metrics
    this.metrics.executionMetrics.totalExecuted++;
    this.metrics.executionMetrics.totalVolume += (orderResult.price * orderResult.quantity);
    
    this.addActivityEvent('trade_executed', 
      `Trade executed: ${task.action} ${task.symbol} at $${orderResult.price}`,
      'success',
      task.symbol,
      { orderId: orderResult.orderId }
    );

    this.emit('tradeExecuted', {
      symbol: task.symbol,
      orderId: orderResult.orderId,
      side: task.action,
      quantity: orderResult.quantity,
      price: orderResult.price
    });
  }

  private async loadActivePositions(): Promise<void> {
    try {
      const positions = await bingxClient.getPositions();
      
      if (positions.code === 0 && positions.data) {
        this.activePositions.clear();
        
        positions.data.forEach((pos: any) => {
          if (parseFloat(pos.positionAmt) !== 0) {
            this.activePositions.set(pos.symbol, {
              symbol: pos.symbol,
              side: parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT',
              entryPrice: parseFloat(pos.entryPrice),
              quantity: Math.abs(parseFloat(pos.positionAmt)),
              unrealizedPnl: parseFloat(pos.unrealizedProfit),
              orderId: ''
            });
          }
        });

        logger.info(`Loaded ${this.activePositions.size} active positions`);
      }
    } catch (error) {
      logger.error('Failed to load active positions:', error);
    }
  }

  private async handleOrderUpdate(data: any): Promise<void> {
    if (data.o) {
      const order = data.o;
      const symbol = order.s;
      
      if (order.X === 'FILLED') {
        logger.info(`Order filled: ${order.i} for ${symbol}`);
        
        try {
          await Trade.update(
            { 
              status: 'FILLED',
              executedQty: order.z,
              avgPrice: order.ap,
              executedAt: new Date()
            },
            { where: { orderId: order.i } }
          );
        } catch (error) {
          logger.error('Failed to update trade in database:', error);
        }
      }
    }
  }

  private async handleAccountUpdate(data: any): Promise<void> {
    if (data.a && data.a.P) {
      data.a.P.forEach((position: any) => {
        const symbol = position.s;
        const amount = parseFloat(position.pa);
        
        if (amount === 0 && this.activePositions.has(symbol)) {
          // Position closed
          this.activePositions.delete(symbol);
          this.tradeExecutorPool.removePosition(symbol);
          
          this.addActivityEvent('position_closed', 
            `Position closed for ${symbol}`,
            'info',
            symbol
          );
          
          this.emit('positionClosed', { symbol });
        } else if (amount !== 0) {
          // Update position
          const pos = this.activePositions.get(symbol);
          if (pos) {
            pos.unrealizedPnl = parseFloat(position.up);
            pos.quantity = Math.abs(amount);
          }
        }
      });
    }
  }

  private updateScanMetrics(symbolCount: number): void {
    const scanTime = Date.now() - this.scanStartTime;
    
    this.metrics.scanningMetrics.totalScans++;
    this.metrics.scanningMetrics.lastScanAt = Date.now();
    
    // Update average scan time
    if (this.metrics.scanningMetrics.avgScanTime === 0) {
      this.metrics.scanningMetrics.avgScanTime = scanTime;
    } else {
      this.metrics.scanningMetrics.avgScanTime = 
        (this.metrics.scanningMetrics.avgScanTime + scanTime) / 2;
    }
    
    // Calculate symbols per second
    this.metrics.scanningMetrics.symbolsPerSecond = symbolCount / (scanTime / 1000);
  }

  private addActivityEvent(
    type: ActivityEvent['type'], 
    message: string, 
    level: ActivityEvent['level'] = 'info', 
    symbol?: string, 
    metadata?: any
  ): void {
    const event: ActivityEvent = {
      id: uuidv4(),
      type,
      symbol,
      message,
      timestamp: Date.now(),
      level,
      metadata
    };

    this.activityEvents.unshift(event);
    
    // Keep only last 100 events
    if (this.activityEvents.length > 100) {
      this.activityEvents = this.activityEvents.slice(0, 100);
    }

    this.emit('activityEvent', event);
  }

  // Public API methods
  getStatus() {
    return {
      isRunning: this.isRunning,
      activePositions: Array.from(this.activePositions.values()),
      config: this.config,
      symbolsCount: this.config.symbolsToScan.length,
      scannedSymbols: this.config.symbolsToScan,
      components: {
        signalWorkerPool: this.signalWorkerPool.getStatus(),
        signalQueue: this.signalQueue.getStatus(),
        tradeExecutorPool: this.tradeExecutorPool.getStatus(),
        marketDataCache: this.marketDataCache.getStatus()
      }
    };
  }

  getMetrics(): ParallelBotMetrics {
    // Update system metrics from components
    const workerPoolMetrics = this.signalWorkerPool.getMetrics();
    const executorPoolMetrics = this.tradeExecutorPool.getMetrics();
    const cacheMetrics = this.marketDataCache.getMetrics();

    this.metrics.systemMetrics.workerUtilization = 
      (workerPoolMetrics.activeWorkers / this.config.signalWorkers.maxWorkers!) * 100;
    
    this.metrics.systemMetrics.cacheHitRate = (cacheMetrics as any).hitRate || 0;
    this.metrics.systemMetrics.throughput = workerPoolMetrics.totalProcessed;
    
    this.metrics.executionMetrics.successRate = executorPoolMetrics.successRate;
    this.metrics.executionMetrics.avgExecutionTime = executorPoolMetrics.avgExecutionTime;

    return { ...this.metrics };
  }

  getActivityEvents(limit: number = 50): ActivityEvent[] {
    return this.activityEvents.slice(0, limit);
  }

  // Compatibility method for TradingFlowMonitor
  getFlowState() {
    // Map internal state to TradingFlowState interface
    const processSteps = [
      {
        id: 'scanning',
        name: 'Market Scanning',
        status: this.isRunning ? 'active' : 'idle',
        startTime: this.metrics.scanningMetrics.lastScanAt,
        duration: this.metrics.scanningMetrics.avgScanTime
      },
      {
        id: 'signal_generation',
        name: 'Signal Generation',
        status: this.signalQueue.getStatus().active > 0 ? 'active' : 'idle',
        startTime: Date.now(),
        duration: this.metrics.signalMetrics.avgSignalLatency
      },
      {
        id: 'decision',
        name: 'Trade Decision',
        status: this.signalQueue.getStatus().processing ? 'active' : 'idle',
        startTime: Date.now(),
        duration: 1000
      },
      {
        id: 'execution',
        name: 'Trade Execution',
        status: this.tradeExecutorPool.getStatus().activeExecutors > 0 ? 'active' : 'idle',
        startTime: Date.now(),
        duration: this.metrics.executionMetrics.avgExecutionTime
      }
    ];

    // Map activity events to signals in process
    const activeSignals = this.activityEvents
      .filter(event => event.type === 'signal_generated')
      .slice(0, 10)
      .map(event => ({
        id: event.id,
        symbol: event.symbol || '',
        stage: 'analyzing' as const,
        startTime: event.timestamp,
        signal: event.metadata?.signal
      }));

    // Map signal queue to execution queue
    const queueStatus = this.signalQueue.getStatus();
    const executionQueue = Array.from({ length: queueStatus.total }, (_, i) => ({
      id: `queue-${i}`,
      symbol: `SYMBOL-${i}`,
      action: 'BUY' as const,
      quantity: this.config.defaultPositionSize,
      estimatedPrice: 0,
      priority: 1,
      queueTime: Date.now(),
      status: 'queued' as const
    }));

    return {
      currentStep: this.isRunning ? 'scanning' : 'idle',
      steps: processSteps,
      activeSignals,
      executionQueue,
      metrics: this.getProcessMetrics(),
      lastUpdate: Date.now()
    };
  }

  // Process metrics compatible with existing interface
  getProcessMetrics() {
    return {
      scanningRate: this.metrics.scanningMetrics.symbolsPerSecond * 60, // symbols per minute
      signalGenerationRate: this.metrics.signalMetrics.totalGenerated, // signals per hour (simplified)
      executionSuccessRate: this.metrics.executionMetrics.successRate,
      averageProcessingTime: {
        scanning: this.metrics.scanningMetrics.avgScanTime,
        analysis: this.metrics.signalMetrics.avgSignalLatency,
        decision: 1000, // placeholder
        execution: this.metrics.executionMetrics.avgExecutionTime
      },
      performance: {
        totalScanned: this.metrics.scanningMetrics.totalScans,
        signalsGenerated: this.metrics.signalMetrics.totalGenerated,
        tradesExecuted: this.metrics.executionMetrics.totalExecuted,
        errors: this.activityEvents.filter(e => e.level === 'error').length
      },
      bottlenecks: this.identifyBottlenecks()
    };
  }

  private identifyBottlenecks(): string[] {
    const bottlenecks: string[] = [];
    
    // Check worker utilization
    if (this.metrics.systemMetrics.workerUtilization > 90) {
      bottlenecks.push('High worker utilization - consider scaling');
    }
    
    // Check queue size
    const queueStatus = this.signalQueue.getStatus();
    if (queueStatus.total > 50) {
      bottlenecks.push('Signal queue backlog detected');
    }
    
    // Check execution rate
    if (this.metrics.executionMetrics.successRate < 80) {
      bottlenecks.push('Low execution success rate');
    }
    
    return bottlenecks;
  }

  updateConfig(config: Partial<ParallelBotConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Update component configurations
    if (config.signalWorkers) {
      this.signalWorkerPool.updateConfig(config.signalWorkers);
    }
    
    if (config.signalQueue) {
      this.signalQueue.updateConfig(config.signalQueue);
    }
    
    if (config.tradeExecutors) {
      this.tradeExecutorPool.updateConfig(config.tradeExecutors);
    }
    
    if (config.marketDataCache) {
      this.marketDataCache.updateConfig(config.marketDataCache);
    }
    
    logger.info('Parallel Trading Bot configuration updated');
  }

  // Advanced controls
  forceSignalScan(symbols?: string[]): void {
    const symbolsToScan = symbols || this.config.symbolsToScan;
    this.signalWorkerPool.addSymbols(symbolsToScan, 10); // High priority
    logger.info(`Forced signal scan for ${symbolsToScan.length} symbols`);
  }

  clearSignalQueue(): void {
    this.signalQueue.clear();
    logger.info('Signal queue cleared');
  }

  invalidateCache(symbol?: string): void {
    this.marketDataCache.invalidateCache(symbol);
    logger.info(`Cache invalidated${symbol ? ` for ${symbol}` : ''}`);
  }
}

// Export singleton instance
let parallelBotInstance: ParallelTradingBot | null = null;

export function getParallelTradingBot(): ParallelTradingBot {
  if (!parallelBotInstance) {
    parallelBotInstance = new ParallelTradingBot();
  }
  return parallelBotInstance;
}

export function startParallelTradingBot(): void {
  const bot = getParallelTradingBot();
  bot.start();
}