import { EventEmitter } from 'events';
import { SignalWorkerPool, SignalWorkerConfig } from './SignalWorkerPool';
import { PrioritySignalQueue, SignalQueueConfig } from './PrioritySignalQueue';
import { TradeExecutorPool, TradeExecutorConfig } from './TradeExecutorPool';
import { MarketDataCache, MarketDataCacheConfig } from './MarketDataCache';
import { PositionManager, PositionManagerConfig } from './PositionManager';
import { apiRequestManager } from '../services/APIRequestManager';
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
  positionManager: Partial<PositionManagerConfig>;
  
  // Advanced execution options
  immediateExecution: boolean; // Execute trades immediately when signals are strong enough
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
    failedSignals: number;
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
  type: 'scan_started' | 'signal_generated' | 'trade_executed' | 'error' | 'position_closed' | 'market_data_updated' | 'blacklist_updated' | 'info';
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
  private symbolBlacklist: Map<string, { count: number, lastFailed: number, backoffUntil: number }> = new Map();
  
  // Core components
  private signalWorkerPool!: SignalWorkerPool;
  private signalQueue!: PrioritySignalQueue;
  private tradeExecutorPool!: TradeExecutorPool;
  private marketDataCache!: MarketDataCache;
  private positionManager!: PositionManager;
  
  // State tracking
  private activePositions: Map<string, Position> = new Map();
  private activityEvents: ActivityEvent[] = [];
  private metrics!: ParallelBotMetrics;
  private scanStartTime: number = 0;
  private totalScans: number = 0;
  private lastScanIndex: number = 0; // Track where scanner left off

  constructor(config?: Partial<ParallelBotConfig>) {
    super();
    
    this.config = {
      enabled: false,
      scanInterval: 900000, // 15 minutes - increased to further reduce API pressure and respect rate limits
      symbolsToScan: [],
      maxConcurrentTrades: 5,
      defaultPositionSize: 100,
      stopLossPercent: 2,
      takeProfitPercent: 3,
      minVolumeUSDT: 10000, // 10K USDT minimum volume (reduced to include more symbols)
      
      // Signal parameters
      rsiOversold: 30,
      rsiOverbought: 70,
      volumeSpikeThreshold: 1.5,
      minSignalStrength: 30, // Temporarily lower for testing signal flow
      confirmationRequired: true,
      ma1Period: 9,
      ma2Period: 21,
      
      // Component configurations
      signalWorkers: {
        maxWorkers: 5,
        maxConcurrentTasks: 15,
        taskTimeout: 15000, // Increased timeout for symbol processing
        retryAttempts: 2
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
        executionTimeout: 20000, // Increased timeout for trade execution
        retryAttempts: 2,
        rateLimit: 2
      },
      marketDataCache: {
        tickerCacheTTL: 5000,
        klineCacheTTL: 30000,
        maxCacheSize: 100,
        priceChangeThreshold: 0.1
      },
      positionManager: {
        enabled: true,
        monitoringInterval: 3000,
        priceCheckThreshold: 0.2,
        emergencyCloseThreshold: 5,
        trailingStopEnabled: false,
        trailingStopPercent: 1,
        maxPositionAge: 12 * 60 * 60 * 1000, // 12 hours
        riskManagement: {
          maxDrawdownPercent: 8,
          maxDailyLoss: 500,
          forceCloseOnError: true
        }
      },
      
      // Advanced options
      immediateExecution: true,
      
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
        failedSignals: 0,
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
    
    // Initialize position manager
    this.positionManager = new PositionManager(this.config.positionManager);
    
    // Integrate position manager with trade executor
    this.tradeExecutorPool.setPositionManager(this.positionManager);
  }

  private setupEventHandlers(): void {
    // Signal worker pool events
    this.signalWorkerPool.on('signalGenerated', (signal) => {
      this.handleSignalGenerated(signal);
    });

    this.signalWorkerPool.on('taskFailed', (error) => {
      this.metrics.signalMetrics.failedSignals++;
      this.handleSymbolError(error.task.symbol, error.error);
      this.addActivityEvent('error', `Signal generation failed: ${error.error}`, 'error', error.task.symbol);
    });

    this.signalWorkerPool.on('circuitBreakerOpened', (info) => {
      this.addActivityEvent('error', 
        `Circuit breaker opened after ${info.consecutiveErrors} consecutive errors. System paused for 5 minutes.`, 
        'error'
      );
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

    // Position manager events
    this.positionManager.on('positionAdded', (position) => {
      this.addActivityEvent('trade_executed',
        `Position under management: ${position.side} ${position.symbol} at $${position.entryPrice}`,
        'info',
        position.symbol,
        { positionId: position.id }
      );
    });

    this.positionManager.on('positionRemoved', ({ position, reason }) => {
      this.activePositions.delete(position.symbol);
      
      let level: 'info' | 'success' | 'warning' = 'info';
      if (reason === 'TAKE_PROFIT') level = 'success';
      else if (reason === 'STOP_LOSS' || reason === 'EMERGENCY') level = 'warning';
      
      this.addActivityEvent('position_closed',
        `Position marked for closure: ${position.symbol} (${reason}) PnL: $${position.unrealizedPnl.toFixed(2)}`,
        level,
        position.symbol,
        { reason, pnl: position.unrealizedPnl }
      );
    });

    this.positionManager.on('positionShouldClose', ({ position, reason, recommendation }) => {
      this.addActivityEvent('position_closed',
        `MANUAL ACTION REQUIRED: ${recommendation}`,
        'warning',
        position.symbol,
        { 
          reason, 
          pnl: position.unrealizedPnl,
          action: 'manual_close_required',
          entryPrice: position.entryPrice,
          currentPnl: position.unrealizedPnl
        }
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
      this.positionManager.start();

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
    this.positionManager.stop();

    this.emit('stopped');
    this.addActivityEvent('scan_started', 'Bot stopped successfully', 'info');
    
    logger.info('Parallel Trading Bot stopped successfully');
  }

  private async updateSymbolList(): Promise<void> {
    try {
      // Predefined popular symbols for immediate start
      const baseSymbols = [
        'BTC-USDT', 'ETH-USDT', 'BNB-USDT', 'SOL-USDT', 'XRP-USDT',
        'ADA-USDT', 'DOGE-USDT', 'DOT-USDT', 'MATIC-USDT', 'AVAX-USDT',
        'LINK-USDT', 'UNI-USDT', 'LTC-USDT', 'BCH-USDT', 'ATOM-USDT'
      ];

      // Start with base symbols immediately
      this.config.symbolsToScan = baseSymbols;
      logger.info(`Preloaded market data for ${baseSymbols.length} symbols`);

      // Async fetch all available symbols from exchange
      this.fetchAllAvailableSymbols().catch(error => {
        logger.warn('Failed to fetch all symbols, continuing with base symbols:', error);
      });

    } catch (error) {
      logger.error('Failed to update symbol list:', error);
    }
  }

  private async fetchAllAvailableSymbols(): Promise<void> {
    try {
      logger.info('Fetching all available symbols from exchange...');
      
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
        .slice(0, 100) // Limit to first 100 symbols to prevent timeouts
        .map((contract: any) => contract.symbol);

      if (usdtSymbols.length === 0) {
        logger.warn('No USDT symbols found from exchange');
        return;
      }

      // Get volume data for all symbols to filter by minimum volume
      const symbolsWithVolume = await this.getSymbolVolumes(usdtSymbols);
      
      // Filter by minimum volume and sort by volume
      const eligibleSymbols = symbolsWithVolume
        .filter(item => item.volume >= this.config.minVolumeUSDT)
        .sort((a, b) => b.volume - a.volume)
        .map(item => item.symbol);

      if (eligibleSymbols.length > 0) {
        this.config.symbolsToScan = eligibleSymbols;
        
        // Preload market data for all symbols
        await this.marketDataCache.preloadSymbols(eligibleSymbols);
        
        logger.info(`Symbol list updated with ${eligibleSymbols.length} symbols`, {
          demoMode: process.env.DEMO_MODE === 'true',
          sampleSymbols: eligibleSymbols.slice(0, 3)
        });
      } else {
        logger.warn('No symbols meet minimum volume criteria, keeping base symbols');
      }

    } catch (error) {
      logger.error('Failed to fetch all available symbols:', error);
    }
  }

  private async getSymbolVolumes(symbols: string[], batchSize = 5): Promise<{symbol: string, volume: number}[]> {
    const symbolsWithVolume: {symbol: string, volume: number}[] = [];
    
    logger.info(`Getting volume data for ${symbols.length} symbols...`);
    
    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      
      const promises = batch.map(async (symbol) => {
        try {
          const ticker: any = await apiRequestManager.getTicker(symbol);
          if (ticker.code === 0 && ticker.data) {
            const volume = parseFloat(ticker.data.quoteVolume || 0);
            return { symbol, volume };
          }
        } catch (error) {
          logger.debug(`Failed to get ticker for ${symbol}:`, error instanceof Error ? error.message : String(error));
        }
        return null;
      });

      const results = await Promise.allSettled(promises);
      
      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          symbolsWithVolume.push(result.value);
        }
      });

      // Delay between batches to respect rate limits and prevent timeouts
      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      
      // Log progress
      if (i % (batchSize * 5) === 0) {
        logger.debug(`Processed ${Math.min(i + batchSize, symbols.length)}/${symbols.length} symbols`);
      }
    }

    logger.info(`Volume data retrieved for ${symbolsWithVolume.length} symbols`);
    return symbolsWithVolume;
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

    // Get available symbols starting from where we left off
    const allSymbols = this.config.symbolsToScan;
    const availableSymbols = [];
    
    // Continue scanning from last index, wrapping around if needed
    let currentIndex = this.lastScanIndex;
    let scannedCount = 0;
    
    while (scannedCount < allSymbols.length && availableSymbols.length < 8) { // Limit batch size
      const symbol = allSymbols[currentIndex];
      
      // Check if symbol is available for scanning
      if (!this.activePositions.has(symbol) && !this.isSymbolBlacklisted(symbol)) {
        availableSymbols.push(symbol);
      } else if (this.isSymbolBlacklisted(symbol)) {
        logger.debug(`Skipping blacklisted symbol: ${symbol}`);
      }
      
      // Move to next symbol, wrap around if at end
      currentIndex = (currentIndex + 1) % allSymbols.length;
      scannedCount++;
    }
    
    // Update scan position for next iteration
    this.lastScanIndex = currentIndex;

    if (availableSymbols.length === 0) {
      logger.debug('No available symbols to scan (all blacklisted or in positions)');
      return;
    }

    this.scanStartTime = Date.now();
    this.totalScans++;

    // Sequential processing - add symbols ONE BY ONE to queue
    logger.debug(`Starting sequential scan of ${availableSymbols.length} symbols (resume from index ${this.lastScanIndex})`);
    this.addActivityEvent('scan_started', 
      `Starting sequential scan of ${availableSymbols.length} symbols (resume from index ${this.lastScanIndex})`, 
      'info'
    );
    
    // Add symbols individually to prevent parallel processing
    const taskIds = this.signalWorkerPool.addSymbols(availableSymbols, 1);
    logger.debug(`Added ${availableSymbols.length} symbols to sequential processing queue → ${taskIds.length} tasks`);
    
    // Update metrics
    this.updateScanMetrics(availableSymbols.length);
    
    logger.debug(`Completed batched processing of ${availableSymbols.length} symbols`);
  }

  private handleSignalGenerated(signal: any): void {
    this.metrics.signalMetrics.totalGenerated++;
    
    logger.debug(`Signal generated: ${signal.symbol} - Action: ${signal.action}, Strength: ${signal.strength}, Required: ${this.config.minSignalStrength}`);
    
    // Only process signals that are actionable
    if (signal.action !== 'HOLD' && signal.strength >= this.config.minSignalStrength) {
      
      // Use immediate execution for high-strength signals if enabled
      if (this.config.immediateExecution && signal.strength >= (this.config.minSignalStrength + 10)) {
        logger.debug(`Attempting immediate execution for strong signal: ${signal.symbol} (${signal.strength}%)`);
        
        // Try immediate execution first - create proper QueuedSignal
        const queuedSignal = {
          id: uuidv4(),
          signal,
          priority: 10,
          queuedAt: Date.now(),
          expiresAt: Date.now() + 30000, // 30 seconds TTL
          processed: false,
          attempts: 0,
          maxAttempts: 3
        };
        
        this.tradeExecutorPool.executeImmediately(
          queuedSignal,
          this.config.defaultPositionSize
        ).then(taskId => {
          if (taskId) {
            logger.info(`Immediate execution initiated for ${signal.symbol}`, { taskId });
          } else {
            // Fallback to normal queue if immediate execution failed
            this.queueSignal(signal);
          }
        }).catch(error => {
          logger.error(`Immediate execution failed for ${signal.symbol}:`, error);
          // Fallback to normal queue
          this.queueSignal(signal);
        });
      } else {
        // Normal queue processing
        this.queueSignal(signal);
      }
    }
  }

  private queueSignal(signal: any): void {
    const queuedId = this.signalQueue.enqueue(signal);
    
    if (queuedId) {
      // Process next signal from queue
      this.processSignalQueue();
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
      const positions = await apiRequestManager.getPositions() as any;
      
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
        marketDataCache: this.marketDataCache.getStatus(),
        positionManager: this.positionManager.getStatus()
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
        status: this.isRunning ? 'processing' : 'idle',
        startTime: this.metrics.scanningMetrics.lastScanAt,
        duration: this.metrics.scanningMetrics.avgScanTime
      },
      {
        id: 'analysis',
        name: 'Signal Generation',
        status: this.signalQueue.getStatus().active > 0 ? 'processing' : 'idle',
        startTime: Date.now(),
        duration: this.metrics.signalMetrics.avgSignalLatency
      },
      {
        id: 'decision',
        name: 'Trade Decision',
        status: this.signalQueue.getStatus().processing ? 'processing' : 'idle',
        startTime: Date.now(),
        duration: 1000
      },
      {
        id: 'execution',
        name: 'Trade Execution',
        status: this.tradeExecutorPool.getStatus().activeExecutors > 0 ? 'processing' : 'idle',
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
    
    if (config.positionManager) {
      this.positionManager.updateConfig(config.positionManager);
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

  // Position management controls
  getManagedPositions() {
    return this.positionManager.getPositions();
  }

  async signalClosePosition(symbol: string): Promise<void> {
    await this.positionManager.signalClosePosition(symbol);
    logger.info(`Close signal sent for position: ${symbol}`);
  }

  async signalCloseAllPositions(): Promise<void> {
    await this.positionManager.signalCloseAllPositions();
    logger.info('Emergency close signal sent for all positions');
  }

  async confirmPositionClosed(symbol: string, actualPnl?: number): Promise<void> {
    await this.positionManager.confirmPositionClosed(symbol, actualPnl);
    logger.info(`Position closure confirmed: ${symbol}`);
  }

  getPositionMetrics() {
    return this.positionManager.getMetrics();
  }

  // Advanced execution controls
  async executeSignalImmediately(symbol: string): Promise<string | null> {
    // Force immediate scan and execution for specific symbol
    const taskIds = this.signalWorkerPool.addSymbols([symbol], 10); // High priority
    
    if (taskIds.length > 0) {
      logger.info(`Forced immediate signal generation for ${symbol}`);
      return taskIds[0];
    }
    
    return null;
  }

  // Toggle immediate execution mode
  setImmediateExecutionMode(enabled: boolean): void {
    this.config.immediateExecution = enabled;
    logger.info(`Immediate execution mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  // Symbol blacklist management for error recovery
  private handleSymbolError(symbol: string, error: string): void {
    const currentTime = Date.now();
    const existing = this.symbolBlacklist.get(symbol);
    
    if (existing) {
      existing.count++;
      existing.lastFailed = currentTime;
      // Exponential backoff: 1min, 5min, 15min, 1hour, 4hours
      const backoffMinutes = Math.min(Math.pow(2, existing.count) * 0.5, 240);
      existing.backoffUntil = currentTime + (backoffMinutes * 60 * 1000);
      
      logger.warn(`Symbol ${symbol} blacklisted for ${backoffMinutes} minutes (failure count: ${existing.count})`);
    } else {
      // First failure - 1 minute backoff
      this.symbolBlacklist.set(symbol, {
        count: 1,
        lastFailed: currentTime,
        backoffUntil: currentTime + (60 * 1000) // 1 minute
      });
      
      logger.warn(`Symbol ${symbol} temporarily blacklisted for 1 minute due to error: ${error}`);
    }
    
    this.addActivityEvent('blacklist_updated', 
      `Symbol ${symbol} blacklisted temporarily (failure ${existing?.count || 1})`, 
      'warning', 
      symbol
    );
  }

  private isSymbolBlacklisted(symbol: string): boolean {
    const blacklistEntry = this.symbolBlacklist.get(symbol);
    if (!blacklistEntry) {
      return false;
    }
    
    const currentTime = Date.now();
    if (currentTime > blacklistEntry.backoffUntil) {
      // Backoff period expired, remove from blacklist
      this.symbolBlacklist.delete(symbol);
      logger.info(`Symbol ${symbol} removed from blacklist - backoff period expired`);
      return false;
    }
    
    return true;
  }

  getBlacklistedSymbols(): Array<{symbol: string, count: number, backoffUntil: number}> {
    const currentTime = Date.now();
    const result: Array<{symbol: string, count: number, backoffUntil: number}> = [];
    
    for (const [symbol, data] of this.symbolBlacklist.entries()) {
      if (currentTime <= data.backoffUntil) {
        result.push({
          symbol,
          count: data.count,
          backoffUntil: data.backoffUntil
        });
      }
    }
    
    return result;
  }

  clearSymbolBlacklist(): void {
    const count = this.symbolBlacklist.size;
    this.symbolBlacklist.clear();
    logger.info(`Cleared ${count} symbols from blacklist`);
    this.addActivityEvent('blacklist_updated', `Manually cleared ${count} symbols from blacklist`, 'info');
  }

  resetCircuitBreaker(): void {
    const status = this.signalWorkerPool.getStatus();
    if (status.circuitBreaker.isOpen) {
      // Reset circuit breaker by reinitializing the signal worker pool
      this.signalWorkerPool.stop();
      this.signalWorkerPool.start();
      
      logger.info('Circuit breaker manually reset');
      this.addActivityEvent('info', 'Circuit breaker manually reset - resuming operations', 'info');
    }
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