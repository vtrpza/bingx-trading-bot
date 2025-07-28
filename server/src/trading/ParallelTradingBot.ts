import { EventEmitter } from 'events';
import { SignalWorkerPool, SignalWorkerConfig } from './SignalWorkerPool';
import { PrioritySignalQueue, SignalQueueConfig } from './PrioritySignalQueue';
import { TradeExecutorPool, TradeExecutorConfig } from './TradeExecutorPool';
import { MarketDataCache, MarketDataCacheConfig } from './MarketDataCache';
import { PositionManager, PositionManagerConfig } from './PositionManager';
import { PositionTracker } from './PositionTracker';
import { RiskManager, RiskParameters } from './RiskManager';
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
  trailingStopPercent: number;
  minVolumeUSDT: number;
  
  // Signal generation parameters
  rsiOversold: number;
  rsiOverbought: number;
  volumeSpikeThreshold: number;
  minSignalStrength: number;
  confirmationRequired: boolean;
  ma1Period: number;
  ma2Period: number;
  
  // Risk Management parameters (new)
  riskRewardRatio: number;
  maxDrawdownPercent: number;
  maxDailyLossUSDT: number;
  maxPositionSizePercent: number;
  
  // Parallel processing configuration
  signalWorkers: Partial<SignalWorkerConfig>;
  signalQueue: Partial<SignalQueueConfig>;
  tradeExecutors: Partial<TradeExecutorConfig>;
  marketDataCache: Partial<MarketDataCacheConfig>;
  positionManager: Partial<PositionManagerConfig>;
  riskManager: Partial<RiskParameters>;
  
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
    rejectedTrades: number;
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
  markPrice?: number;
  percentage?: number;
  notional?: number;
  liquidationPrice?: number;
  maintMargin?: number;
  updateTime?: number;
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
  private positionTracker!: PositionTracker;
  private riskManager!: RiskManager;
  
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
      scanInterval: parseInt(process.env.SCAN_INTERVAL || '15000'), // 15 seconds - ULTRA FAST scanning
      symbolsToScan: [],
      maxConcurrentTrades: 5,
      defaultPositionSize: 100, // Safe under 5000 USDT limit with leverage
      stopLossPercent: 2,
      takeProfitPercent: 3,
      trailingStopPercent: 1,
      minVolumeUSDT: 10000, // 10K USDT minimum volume (reduced to include more symbols)
      
      // Signal parameters
      rsiOversold: 30,
      rsiOverbought: 70,
      volumeSpikeThreshold: 1.5,
      minSignalStrength: 30, // Temporarily lower for testing signal flow
      confirmationRequired: true,
      ma1Period: 9,
      ma2Period: 21,
      
      // Risk Management parameters (with sensible defaults)
      riskRewardRatio: 2.0,
      maxDrawdownPercent: 15,
      maxDailyLossUSDT: 500,
      maxPositionSizePercent: 20,
      
      // Component configurations
      signalWorkers: {
        maxWorkers: 12, // Increased workers for better parallelism
        maxConcurrentTasks: 20, // Increased concurrent tasks for batch processing
        taskTimeout: 12000, // Optimized timeout for batch operations
        retryAttempts: 1, // Reduced retries for faster processing
        enableParallelProcessing: true, // 🚀 ENABLED for ultra-fast batch processing
        batchSize: 15 // Increased batch size for maximum performance
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
      riskManager: {
        maxDrawdownPercent: 8,
        maxDailyLossUSDT: 500,
        maxPositionSizePercent: 25, // 25% of balance per position
        stopLossPercent: 2,
        takeProfitPercent: 3,
        trailingStopPercent: 1.5,
        riskRewardRatio: 2,
        maxLeverage: 10
      },
      
      // Advanced options
      immediateExecution: true,
      
      ...config
    };
    
    // FORCE ULTRA PERFORMANCE - Always override to 15s
    if (this.config.scanInterval > 15000) {
      this.config.scanInterval = 15000;
      logger.info(`⚡ ULTRA PERFORMANCE: Forcing scan interval to ${this.config.scanInterval}ms`);
    }
    
    logger.info(`🚀 ParallelTradingBot initialized with scanInterval: ${this.config.scanInterval}ms`);

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
        rejectedTrades: 0,
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
      signalConfig,
      minVolumeUSDT: this.config.minVolumeUSDT,
      symbolProcessingEnabled: true // Enable integrated symbol processing
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
    
    // Initialize position tracker for real-time monitoring
    this.positionTracker = new PositionTracker({
      entryStrategy: 'SMART_ENTRY',
      entryPriceOffset: 0.05,
      maxSlippage: 0.1,
      positionSizing: 'VOLATILITY_BASED',
      riskPerTrade: 2,
      stopLossStrategy: 'ATR',
      takeProfitStrategy: 'SCALED',
      riskRewardRatio: 2.5
    });
    
    // Initialize risk manager with parameters from frontend configuration
    this.riskManager = new RiskManager({
      maxDrawdownPercent: this.config.maxDrawdownPercent || 15,
      maxDailyLossUSDT: this.config.maxDailyLossUSDT || 500,
      maxPositionSizePercent: this.config.maxPositionSizePercent || 20,
      stopLossPercent: this.config.stopLossPercent || 2,
      takeProfitPercent: this.config.takeProfitPercent || 3,
      trailingStopPercent: this.config.trailingStopPercent || 1,
      riskRewardRatio: this.config.riskRewardRatio || 2.0,
      maxLeverage: this.config.riskManager?.maxLeverage || 10
    });
    
    // Integrate position manager with trade executor
    this.tradeExecutorPool.setPositionManager(this.positionManager);
    
    // 🔧 SET BOT CONFIGURATION FOR VALIDATION
    this.tradeExecutorPool.setBotConfig(this.config);
    
    // 🌐 INTEGRATE WEBSOCKET FOR NOTIFICATIONS
    // Create a broadcast function that uses the global broadcast function
    const createBroadcastFunction = () => {
      return (type: string, data: any) => {
        this.emit('tradeRejected', { type, data });
      };
    };
    this.tradeExecutorPool.setBroadcastFunction(createBroadcastFunction());
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
      
      // Emergency stop all components during circuit breaker
      this.handleCircuitBreakerOpened(info);
    });

    // 🚀 NEW: Symbol processing events
    this.signalWorkerPool.on('symbolsProcessed', (data) => {
      this.config.symbolsToScan = data.symbols;
      const waveInfo = data.wave ? ` (Wave ${data.wave}/${data.totalWaves})` : '';
      this.addActivityEvent('info', 
        `Symbols processed: ${data.count} symbols ready for scanning${waveInfo}`, 
        'success'
      );
      logger.info(`🚀 Symbols integrated: ${data.count} symbols loaded from SignalWorkerPool${waveInfo}`);
    });

    // 🚀 Progressive loading wave updates
    this.signalWorkerPool.on('symbolWaveAdded', (data) => {
      this.config.symbolsToScan = this.signalWorkerPool.getAvailableSymbols();
      this.addActivityEvent('info', 
        `Symbol wave added: ${data.newSymbols.length} new symbols (${data.totalSymbols} total, ${data.progress.toFixed(1)}% complete)`, 
        'info'
      );
      logger.info(`🌊 Wave ${data.wave}: Added ${data.newSymbols.length} symbols, total active: ${data.totalSymbols}`);
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

    this.signalQueue.on('signalDequeued', async (queuedSignal) => {
      this.metrics.signalMetrics.processedSignals++;
      // Send to trade executor
      // SMART POSITION SIZING: Calculate safe position per asset
      const smartPositionSize = this.calculateSmartPositionSize(queuedSignal.signal.symbol);
      await this.tradeExecutorPool.addSignal(queuedSignal, smartPositionSize);
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

    // 🚫 TRADE REJECTION EVENT HANDLER
    this.tradeExecutorPool.on('tradeRejected', (rejection) => {
      this.addActivityEvent('error', 
        `Trade rejected: ${rejection.rejectionReason.message}`, 
        'warning', 
        rejection.task.symbol,
        { 
          rejectionCode: rejection.rejectionReason.code,
          details: rejection.rejectionReason.details
        }
      );
      
      // Track rejection metrics
      this.metrics.signalMetrics.rejectedTrades = (this.metrics.signalMetrics.rejectedTrades || 0) + 1;
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

    // Risk manager events - STRICT ERROR HANDLING
    this.riskManager.on('emergencyStop', (positionRisk) => {
      this.addActivityEvent('error',
        `EMERGENCY STOP: ${positionRisk.symbol} at critical risk level`,
        'error',
        positionRisk.symbol,
        { riskLevel: positionRisk.riskLevel, pnl: positionRisk.unrealizedPnl }
      );
      // Force close position immediately
      this.signalClosePosition(positionRisk.symbol);
    });

    this.riskManager.on('moveToBreakEven', (positionRisk) => {
      this.addActivityEvent('info',
        `BREAK-EVEN: Moving ${positionRisk.symbol} to break-even`,
        'info',
        positionRisk.symbol,
        { breakEvenPrice: positionRisk.breakEvenPrice }
      );
    });

    this.riskManager.on('activateTrailingStop', (positionRisk) => {
      this.addActivityEvent('info',
        `TRAILING STOP: Activating for ${positionRisk.symbol}`,
        'info',
        positionRisk.symbol,
        { trailingStopPrice: positionRisk.trailingStopPrice }
      );
    });

    this.riskManager.on('dailyLimitExceeded', (data) => {
      this.addActivityEvent('error',
        `DAILY LIMIT EXCEEDED: ${data.dailyPnl.toFixed(2)} > ${data.limit}`,
        'error',
        undefined,
        { action: 'stop_all_trading' }
      );
      // Emergency stop all trading
      this.signalCloseAllPositions();
    });

    this.riskManager.on('riskMonitoringError', (error) => {
      this.addActivityEvent('error',
        `RISK MONITORING ERROR: ${error}`,
        'error',
        undefined,
        { action: 'manual_intervention_required' }
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

      // Start all components - SignalWorkerPool now processes symbols on start
      this.marketDataCache.start();
      await this.signalWorkerPool.start(); // Now async and processes symbols
      this.tradeExecutorPool.start();
      this.positionManager.start();
      this.positionTracker.start();

      // Start risk manager - CRITICAL for production trading
      try {
        await this.riskManager.start();
        this.addActivityEvent('info', 'Risk Manager started - STRICT MODE enabled', 'success');
      } catch (error) {
        logger.error('CRITICAL: Failed to start Risk Manager:', error);
        this.addActivityEvent('error', `CRITICAL: Risk Manager failed to start: ${error}`, 'error');
        throw new Error(`Cannot start trading bot without risk management: ${error}`);
      }

      // Load active positions
      await this.loadActivePositions();

      // 🚀 SYMBOLS ARE NOW PROCESSED BY SIGNALWORKERPOOL - No need to call updateSymbolList
      // Wait for symbols to be processed if not ready yet
      if (!this.signalWorkerPool.areSymbolsReady()) {
        logger.info('⏳ Waiting for symbol processing to complete...');
        await new Promise<void>((resolve) => {
          const checkSymbols = () => {
            if (this.signalWorkerPool.areSymbolsReady()) {
              this.config.symbolsToScan = this.signalWorkerPool.getAvailableSymbols();
              resolve();
            } else {
              setTimeout(checkSymbols, 1000);
            }
          };
          checkSymbols();
        });
      } else {
        this.config.symbolsToScan = this.signalWorkerPool.getAvailableSymbols();
      }
      
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
    this.positionTracker.stop();
    this.riskManager.stop();

    this.emit('stopped');
    this.addActivityEvent('scan_started', 'Bot stopped successfully', 'info');
    
    logger.info('Parallel Trading Bot stopped successfully');
  }

  // 🚀 DEPRECATED: Symbol processing now handled by SignalWorkerPool
  // Kept for potential compatibility/fallback purposes
  private async updateSymbolList(): Promise<void> {
    logger.warn('⚠️ DEPRECATED: updateSymbolList() is deprecated. Symbol processing is now handled by SignalWorkerPool.');
    
    // Fallback: refresh symbols via SignalWorkerPool
    try {
      await this.signalWorkerPool.refreshSymbols();
      this.config.symbolsToScan = this.signalWorkerPool.getAvailableSymbols();
    } catch (error) {
      logger.error('Failed to refresh symbols via SignalWorkerPool:', error);
      // Ultimate fallback
      this.config.symbolsToScan = ['BTC-USDT', 'ETH-USDT', 'BNB-USDT'];
    }
  }

  // Legacy method for emergency fallback
  async refreshSymbolsLegacy(): Promise<void> {
    await this.updateSymbolList();
  }

  // Legacy method for direct symbol fetching
  async fetchSymbolsLegacy(): Promise<void> {
    await this.fetchAllAvailableSymbols();
  }

  // 🚀 DEPRECATED: Symbol processing now handled by SignalWorkerPool
  // Kept for potential compatibility/fallback purposes
  private async fetchAllAvailableSymbols(): Promise<void> {
    logger.warn('⚠️ DEPRECATED: fetchAllAvailableSymbols() is deprecated. Symbol processing is now handled by SignalWorkerPool.');
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
        .slice(0, 500) // Increased limit to 500 symbols for better coverage
        .map((contract: any) => contract.symbol);

      if (usdtSymbols.length === 0) {
        logger.warn('No USDT symbols found from exchange');
        return;
      }

      // Get volume data for all symbols to filter by minimum volume
      const symbolsWithVolume = await this.getSymbolVolumes(usdtSymbols);
      
      // Sort by volume and take top symbols (ensure minimum 50 symbols)
      const sortedSymbols = symbolsWithVolume
        .sort((a, b) => b.volume - a.volume);
      
      // First try with volume filter
      let eligibleSymbols = sortedSymbols
        .filter(item => item.volume >= this.config.minVolumeUSDT)
        .map(item => item.symbol);
      
      // If we don't have enough symbols, take top 50 by volume regardless of minimum
      if (eligibleSymbols.length < 50) {
        eligibleSymbols = sortedSymbols
          .slice(0, 50) // Take top 50 by volume
          .map(item => item.symbol);
        logger.info(`⚡ Taking top 50 symbols by volume (relaxed volume filter)`);
      } else {
        // Limit to top 50 if we have too many
        eligibleSymbols = eligibleSymbols.slice(0, 50);
      }

      if (eligibleSymbols.length > 0) {
        this.config.symbolsToScan = eligibleSymbols;
        
        // Preload market data for all symbols
        await this.marketDataCache.preloadSymbols(eligibleSymbols);
        
        logger.info(`🚀 Symbol list updated with ${eligibleSymbols.length} symbols from API`, {
          demoMode: process.env.DEMO_MODE === 'true',
          sampleSymbols: eligibleSymbols.slice(0, 5),
          minVolume: this.config.minVolumeUSDT,
          totalAvailable: symbolsWithVolume.length
        });
      } else {
        logger.warn('No symbols meet minimum volume criteria, keeping base symbols');
      }

    } catch (error) {
      logger.error('Failed to fetch all available symbols:', error);
    }
  }

  // 🚀 DEPRECATED: Symbol processing now handled by SignalWorkerPool
  private async getSymbolVolumes(symbols: string[], batchSize = 20): Promise<{symbol: string, volume: number}[]> {
    logger.warn('⚠️ DEPRECATED: getSymbolVolumes() is deprecated. Symbol processing is now handled by SignalWorkerPool.');
    const symbolsWithVolume: {symbol: string, volume: number}[] = [];
    
    logger.info(`🚀 ULTRA-FAST: Getting volume data for ${symbols.length} symbols with ${batchSize} parallel requests...`);
    const startTime = Date.now();
    
    // 🚀 ULTRA-AGGRESSIVE: 20 parallel requests (vs 5 original) with NO delays
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

      // 🚀 NO DELAYS: Remove rate limit delays - let the new rate limiter handle it
      // The new GlobalRateLimiter with 25 req/s for market data can handle this
      
      // Progress logging every 100 symbols
      if (i % 100 === 0 && i > 0) {
        const progress = (i / symbols.length * 100).toFixed(1);
        const elapsed = Date.now() - startTime;
        const rate = i / (elapsed / 1000);
        logger.info(`📊 Progress: ${progress}% (${i}/${symbols.length}) at ${rate.toFixed(1)} symbols/sec`);
      }
    }

    const totalTime = Date.now() - startTime;
    const rate = symbols.length / (totalTime / 1000);
    logger.info(`⚡ ULTRA-FAST COMPLETE: ${symbolsWithVolume.length} symbols processed in ${totalTime}ms (${rate.toFixed(1)} symbols/sec)`);
    
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
    logger.info(`🚀 ULTRA FAST SYMBOL SCAN - Cycle #${this.totalScans + 1}`);
    
    // 🚀 OPTIMIZATION: Sync positions less frequently (every 3rd scan cycle)
    if (this.totalScans % 3 === 0) {
      await this.syncPositionsWithBingX();
      logger.debug('📊 Position sync completed (every 3rd cycle)');
    }
    
    if (this.activePositions.size >= this.config.maxConcurrentTrades) {
      logger.warn(`⚠️ Max concurrent trades reached (${this.activePositions.size}/${this.config.maxConcurrentTrades}), skipping scan`);
      return;
    }

    // 🚀 ULTRA PERFORMANCE: Process ALL available symbols in one massive batch
    const allSymbols = this.config.symbolsToScan;
    logger.info(`🔍 SCAN DEBUG: Starting with ${allSymbols.length} configured symbols: ${allSymbols.slice(0, 10).join(', ')}${allSymbols.length > 10 ? '...' : ''}`);
    
    const availableSymbols = allSymbols.filter(symbol => 
      !this.activePositions.has(symbol) && !this.isSymbolBlacklisted(symbol)
    );

    logger.info(`🔍 SCAN DEBUG: After filtering - ${availableSymbols.length}/${allSymbols.length} symbols available. Active positions: ${this.activePositions.size}, Blacklisted: ${Array.from(this.symbolBlacklist).length}`);

    if (availableSymbols.length === 0) {
      logger.warn('No available symbols to scan (all blacklisted or in positions)');
      return;
    }

    this.scanStartTime = Date.now();
    this.totalScans++;

    // 🚀 ULTRA FAST: Process up to 50 symbols simultaneously with batch processing
    const batchSize = Math.min(50, availableSymbols.length);
    const symbolsToProcess = availableSymbols.slice(0, batchSize);

    logger.info(`🚀 BATCH SCAN: Processing ${symbolsToProcess.length} symbols simultaneously (${availableSymbols.length} available)`);
    this.addActivityEvent('scan_started', 
      `ULTRA FAST: Batch processing ${symbolsToProcess.length} symbols simultaneously`, 
      'info'
    );
    
    // 🚀 MASSIVE PERFORMANCE BOOST: Add all symbols to batch processing queue
    const taskIds = this.signalWorkerPool.addSymbols(symbolsToProcess, 1);
    logger.info(`🎯 QUEUED: ${taskIds.length} symbols for ultra-fast batch processing`);
    
    // Update metrics
    this.updateScanMetrics(symbolsToProcess.length);
    
    const scanTime = Date.now() - this.scanStartTime;
    logger.info(`⚡ SCAN COMPLETED: ${symbolsToProcess.length} symbols queued for batch processing in ${scanTime}ms`);
  }

  private async handleSignalGenerated(signal: any): Promise<void> {
    this.metrics.signalMetrics.totalGenerated++;
    
    // Enhanced logging for debugging
    logger.info(`📊 SIGNAL GENERATED for ${signal.symbol}:`, {
      action: signal.action,
      strength: signal.strength,
      minRequired: this.config.minSignalStrength,
      indicators: signal.indicators,
      conditions: signal.conditions,
      reason: signal.reason
    });
    
    // Emit signal for WebSocket broadcasting (includes HOLD signals for frontend display)
    this.emit('signal', signal);
    logger.debug(`📡 Signal emitted to WebSocket: ${signal.symbol} ${signal.action}`);
    
    // Only process signals that are actionable for trading
    if (signal.action === 'HOLD') {
      logger.info(`⏸️ HOLD signal for ${signal.symbol} - No trade action needed`);
      return;
    }
    
    if (signal.strength < this.config.minSignalStrength) {
      logger.info(`❌ Signal strength too low for ${signal.symbol}: ${signal.strength}% < ${this.config.minSignalStrength}% required`);
      return;
    }
    
    logger.info(`✅ ACTIONABLE SIGNAL for ${signal.symbol}: ${signal.action} (${signal.strength}%) - Proceeding to validation...`);
    
    if (signal.action !== 'HOLD' && signal.strength >= this.config.minSignalStrength) {
      
      // STRICT RISK VALIDATION - No fallbacks as per user requirement
      try {
        // Get current price for validation
        const currentPrice = await this.getCurrentPrice(signal.symbol);
        
        // Validate trade through RiskManager BEFORE any execution
        const validation = await this.riskManager.validateTrade(
          signal.symbol,
          signal.action,
          this.config.defaultPositionSize / currentPrice, // Convert to quantity
          currentPrice
        );

        if (!validation.isValid) {
          // STRICT: Show errors, no fallbacks
          const errorMsg = `Trade validation FAILED for ${signal.symbol}: ${validation.errors.join(', ')}`;
          logger.error(errorMsg);
          this.addActivityEvent('error', errorMsg, 'error', signal.symbol, { 
            validationErrors: validation.errors,
            action: 'trade_rejected' 
          });
          return; // Stop execution - no fallbacks
        }

        // Log warnings if any
        if (validation.warnings.length > 0) {
          logger.warn(`Trade warnings for ${signal.symbol}: ${validation.warnings.join(', ')}`);
          this.addActivityEvent('info', 
            `Trade warnings: ${validation.warnings.join(', ')}`, 
            'warning', 
            signal.symbol
          );
        }

        // Trade passed validation - proceed with execution
        logger.info(`Trade VALIDATED for ${signal.symbol}:`, {
          riskAmount: validation.riskAssessment.riskAmount.toFixed(2),
          rewardPotential: validation.riskAssessment.rewardPotential.toFixed(2),
          riskRewardRatio: validation.riskAssessment.riskRewardRatio.toFixed(2)
        });

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
        
      } catch (error) {
        // STRICT: Show error, no fallbacks
        const errorMsg = `CRITICAL: Risk validation error for ${signal.symbol}: ${error}`;
        logger.error(errorMsg);
        this.addActivityEvent('error', errorMsg, 'error', signal.symbol, { 
          action: 'validation_failed',
          requiresManualIntervention: true 
        });
        return; // Stop execution - no fallbacks
      }
    }
  }

  // Helper method to get current price
  private async getCurrentPrice(symbol: string): Promise<number> {
    try {
      const ticker = await apiRequestManager.getTicker(symbol) as any;
      
      if (!ticker.data || !ticker.data.lastPrice) {
        throw new Error('Unable to fetch current price');
      }

      return parseFloat(ticker.data.lastPrice);
    } catch (error) {
      throw new Error(`Failed to get current price for ${symbol}: ${error}`);
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

  // Get real-time positions directly from BingX API with enhanced data processing
  private async getBingXRealTimePositions(): Promise<any[]> {
    try {
      const positions = await apiRequestManager.getPositions() as any;
      
      if (positions.code === 0 && positions.data) {
        const activePositions = positions.data
          .filter((pos: any) => {
            const amount = parseFloat(pos.positionAmt || '0');
            return !isNaN(amount) && amount !== 0;
          })
          .map((pos: any) => {
            const positionAmt = parseFloat(pos.positionAmt);
            const isLong = positionAmt > 0;
            const entryPrice = parseFloat(pos.entryPrice || pos.avgPrice || '0');
            const markPrice = parseFloat(pos.markPrice || '0');
            const unrealizedPnl = parseFloat(pos.unrealizedProfit || '0');
            const percentage = parseFloat(pos.percentage || '0');
            
            // Enhanced position data processing
            const enhancedPosition = {
              symbol: pos.symbol,
              positionAmt: pos.positionAmt,
              entryPrice: entryPrice > 0 ? entryPrice.toFixed(6) : '0.000000',
              markPrice: markPrice > 0 ? markPrice.toFixed(6) : '0.000000',
              unrealizedProfit: unrealizedPnl.toFixed(6),
              percentage: percentage.toFixed(2),
              side: isLong ? 'LONG' : 'SHORT',
              quantity: Math.abs(positionAmt),
              
              // Additional calculated fields
              notional: Math.abs(positionAmt * markPrice).toFixed(2),
              pnlPercent: entryPrice > 0 ? ((markPrice - entryPrice) / entryPrice * 100 * (isLong ? 1 : -1)).toFixed(2) : '0.00',
              
              // Risk metrics
              liquidationPrice: pos.liquidationPrice || '0',
              maintMargin: pos.maintMargin || '0',
              
              // Timestamps for tracking
              updateTime: pos.updateTime || Date.now(),
              
              // Raw data for debugging
              rawData: pos
            };
            
            // Sync internal tracking with accurate entry price
            this.activePositions.set(pos.symbol, {
              symbol: pos.symbol,
              side: isLong ? 'LONG' : 'SHORT',
              entryPrice: entryPrice,
              quantity: Math.abs(positionAmt),
              unrealizedPnl: unrealizedPnl,
              orderId: '',
              markPrice: markPrice,
              percentage: percentage
            });
            
            return enhancedPosition;
          });

        if (activePositions.length > 0) {
          logger.debug(`Retrieved ${activePositions.length} real-time positions from BingX`, {
            positions: activePositions.map((p: any) => ({ 
              symbol: p.symbol, 
              amount: p.positionAmt,
              entryPrice: p.entryPrice,
              markPrice: p.markPrice,
              pnl: p.unrealizedProfit
            }))
          });
        }
        
        return activePositions;
      }
      
      return [];
    } catch (error) {
      logger.error('Failed to get real-time positions:', error);
      // Fallback to internal tracking with enhanced formatting
      return Array.from(this.activePositions.values()).map(pos => ({
        symbol: pos.symbol,
        positionAmt: pos.side === 'LONG' ? pos.quantity : -pos.quantity,
        entryPrice: pos.entryPrice.toFixed(6),
        markPrice: pos.markPrice?.toFixed(6) || '0.000000',
        unrealizedProfit: pos.unrealizedPnl.toFixed(6),
        percentage: pos.percentage?.toFixed(2) || '0.00',
        side: pos.side,
        quantity: pos.quantity,
        notional: ((pos.markPrice || 0) * pos.quantity).toFixed(2),
        pnlPercent: '0.00',
        liquidationPrice: '0',
        maintMargin: '0',
        updateTime: Date.now()
      }));
    }
  }

  // Sync internal positions with real BingX positions
  private async syncPositionsWithBingX(): Promise<void> {
    try {
      const positions = await apiRequestManager.getPositions() as any;
      
      if (positions.code === 0 && positions.data) {
        const realPositions = new Set<string>();
        
        // Update/add positions that exist in BingX
        positions.data.forEach((pos: any) => {
          if (parseFloat(pos.positionAmt) !== 0) {
            const symbol = pos.symbol;
            realPositions.add(symbol);
            
            this.activePositions.set(symbol, {
              symbol: symbol,
              side: parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT',
              entryPrice: parseFloat(pos.entryPrice),
              quantity: Math.abs(parseFloat(pos.positionAmt)),
              unrealizedPnl: parseFloat(pos.unrealizedProfit || '0'),
              orderId: ''
            });
          }
        });
        
        // Remove positions that no longer exist in BingX
        const currentTrackedSymbols = Array.from(this.activePositions.keys());
        currentTrackedSymbols.forEach(symbol => {
          if (!realPositions.has(symbol)) {
            this.activePositions.delete(symbol);
            logger.debug(`Removed closed position from tracking: ${symbol}`);
          }
        });
        
        const positionCount = this.activePositions.size;
        if (positionCount > 0) {
          logger.debug(`Synced ${positionCount} positions with BingX`);
        }
      }
    } catch (error) {
      // Only log error if it's not a common demo mode issue
      if (process.env.DEMO_MODE !== 'true') {
        logger.error('Failed to sync positions with BingX:', error);
      }
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
  async getStatus() {
    // Get real-time positions from BingX API
    const realTimePositions = await this.getBingXRealTimePositions();
    
    return {
      isRunning: this.isRunning,
      activePositions: realTimePositions,
      config: this.config,
      symbolsCount: this.config.symbolsToScan.length,
      scannedSymbols: this.config.symbolsToScan,
      components: {
        signalWorkerPool: this.signalWorkerPool.getStatus(),
        signalQueue: this.signalQueue.getStatus(),
        tradeExecutorPool: this.tradeExecutorPool.getStatus(),
        marketDataCache: this.marketDataCache.getStatus(),
        positionManager: this.positionManager.getStatus(),
        riskManager: {
          isActive: this.riskManager.isRiskManagerActive(),
          dailyPnl: this.riskManager.getDailyPnl(),
          riskParameters: this.riskManager.getRiskParameters()
        },
        progressiveLoading: this.signalWorkerPool.getProgressiveLoadingStatus()
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
    
    // Update RiskManager parameters if any risk management fields changed
    const riskFields = ['riskRewardRatio', 'maxDrawdownPercent', 'maxDailyLossUSDT', 'maxPositionSizePercent', 'stopLossPercent', 'takeProfitPercent', 'trailingStopPercent'];
    const hasRiskUpdate = riskFields.some(field => config[field as keyof ParallelBotConfig] !== undefined);
    
    if (hasRiskUpdate && this.riskManager) {
      this.riskManager.updateRiskParameters({
        riskRewardRatio: this.config.riskRewardRatio,
        maxDrawdownPercent: this.config.maxDrawdownPercent,
        maxDailyLossUSDT: this.config.maxDailyLossUSDT,
        maxPositionSizePercent: this.config.maxPositionSizePercent,
        stopLossPercent: this.config.stopLossPercent,
        takeProfitPercent: this.config.takeProfitPercent,
        trailingStopPercent: this.config.trailingStopPercent,
        maxLeverage: this.config.riskManager?.maxLeverage || 10
      });
      
      logger.info('Risk management parameters updated:', {
        riskRewardRatio: this.config.riskRewardRatio,
        maxDrawdownPercent: this.config.maxDrawdownPercent,
        maxDailyLossUSDT: this.config.maxDailyLossUSDT,
        maxPositionSizePercent: this.config.maxPositionSizePercent
      });
    }
    
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
    
    // Restart scanning if scanInterval was changed
    if (config.scanInterval && this.isRunning && this.scanInterval) {
      logger.info(`⚡ Restarting scanner with new interval: ${this.config.scanInterval}ms`);
      clearInterval(this.scanInterval);
      this.startScanning();
    }
    
    logger.info('Parallel Trading Bot configuration updated');
  }

  /**
   * 🧠 SMART POSITION SIZING
   * Calculates optimal position size based on asset characteristics
   */
  private calculateSmartPositionSize(symbol: string): number {
    try {
      // Get current balance (simplified - you can enhance this)
      const estimatedBalance = 10000; // USDT - should get from account balance
      
      // Use TradeExecutorPool's intelligent sizing
      const recommendedSize = this.tradeExecutorPool.getRecommendedPositionSize(symbol, estimatedBalance);
      
      // Apply user's position size preference as a multiplier
      const userMultiplier = this.config.defaultPositionSize / 100; // Normalize to 1.0
      const finalSize = recommendedSize * userMultiplier;
      
      logger.debug(`🎯 Smart sizing for ${symbol}: base=${recommendedSize}, user=${userMultiplier}x, final=${finalSize}`);
      
      return Math.max(10, finalSize); // Minimum 10 USDT
    } catch (error) {
      logger.warn(`Failed to calculate smart position size for ${symbol}, using default:`, error);
      return this.config.defaultPositionSize;
    }
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

  getPositionMetrics() {
    return this.positionManager.getMetrics();
  }

  // Position tracker methods for enhanced real-time data
  getRealTimePositions() {
    return this.positionTracker.getPositions();
  }

  getPositionSnapshot() {
    return this.positionTracker.getLatestSnapshot();
  }

  getTradingStrategy() {
    return this.positionTracker.getStrategy();
  }

  updateTradingStrategy(strategy: any) {
    return this.positionTracker.updateStrategy(strategy);
  }


  async signalClosePosition(symbol: string, options?: { reason?: string; percentage?: number }): Promise<void> {
    const { reason = 'Manual close', percentage = 100 } = options || {};
    
    if (percentage === 100) {
      await this.positionManager.signalClosePosition(symbol);
    } else {
      // For partial closes, we'll signal through position manager with metadata
      await this.positionManager.signalPartialClosePosition(symbol, percentage, reason);
    }
    
    logger.info(`Close signal sent for position: ${symbol} (${percentage}% - ${reason})`);
  }

  async signalCloseAllPositions(): Promise<void> {
    await this.positionManager.signalCloseAllPositions();
    logger.info('Emergency close signal sent for all positions');
  }

  async confirmPositionClosed(symbol: string, actualPnl?: number): Promise<void> {
    await this.positionManager.confirmPositionClosed(symbol, actualPnl);
    logger.info(`Position closure confirmed: ${symbol}`);
  }

  async updatePositionLevels(symbol: string, levels: { stopLoss?: number; takeProfit?: number }): Promise<void> {
    await this.positionManager.updatePositionLevels(symbol, levels);
    logger.info(`Position levels updated for ${symbol}:`, levels);
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

  /**
   * 🚀 PROGRESSIVE LOADING: Force next symbol wave
   */
  forceNextSymbolWave(): void {
    this.signalWorkerPool.forceNextSymbolWave();
    this.addActivityEvent('info', 'Manually triggered next symbol wave', 'info');
  }

  /**
   * 🚀 PROGRESSIVE LOADING: Get progressive loading status
   */
  getProgressiveLoadingStatus() {
    return this.signalWorkerPool.getProgressiveLoadingStatus();
  }

  private handleCircuitBreakerOpened(info: any): void {
    logger.warn('Circuit breaker opened - initiating emergency procedures');
    
    try {
      // Stop market data cache to prevent stale data
      this.marketDataCache.emergencyStop();
      
      // Log current queue status for debugging
      const queueStatus = this.signalQueue.getStatus();
      logger.info(`Circuit breaker: ${queueStatus.total} signals in queue during emergency`);
      
      logger.info('Emergency procedures completed for circuit breaker');
    } catch (error) {
      logger.error('Error during circuit breaker emergency procedures:', error);
    }
  }

  // Risk Management Controls
  getRiskManagerStatus() {
    return {
      isActive: this.riskManager.isRiskManagerActive(),
      dailyPnl: this.riskManager.getDailyPnl(),
      riskParameters: this.riskManager.getRiskParameters()
    };
  }

  updateRiskParameters(newParams: Partial<RiskParameters>): void {
    this.riskManager.updateRiskParameters(newParams);
    logger.info('Risk parameters updated via bot interface:', newParams);
    this.addActivityEvent('info', `Risk parameters updated: ${Object.keys(newParams).join(', ')}`, 'info');
  }

  // Manual trade validation for testing
  async validateTradeManually(symbol: string, side: 'BUY' | 'SELL', size: number, entryPrice: number) {
    try {
      const validation = await this.riskManager.validateTrade(symbol, side, size, entryPrice);
      
      logger.info(`Manual trade validation for ${symbol}:`, {
        isValid: validation.isValid,
        errors: validation.errors,
        warnings: validation.warnings,
        riskAssessment: validation.riskAssessment
      });

      return validation;
    } catch (error) {
      logger.error(`Manual trade validation failed for ${symbol}:`, error);
      throw error;
    }
  }
}

// Export singleton instance
let parallelBotInstance: ParallelTradingBot | null = null;

export function getParallelTradingBot(): ParallelTradingBot {
  if (!parallelBotInstance) {
    // Force ultra performance configuration
    const { ultraPerformanceConfig } = require('./ParallelBotConfiguration');
    logger.info('🚀 Initializing ParallelTradingBot with ULTRA PERFORMANCE configuration');
    parallelBotInstance = new ParallelTradingBot(ultraPerformanceConfig);
  }
  return parallelBotInstance;
}

export function startParallelTradingBot(): void {
  const bot = getParallelTradingBot();
  
  // FORCE ULTRA PERFORMANCE before starting
  const { ultraPerformanceConfig } = require('./ParallelBotConfiguration');
  bot.updateConfig({
    ...ultraPerformanceConfig,
    scanInterval: 15000 // FORCE 15 seconds always
  });
  
  logger.info('🚀 STARTING BOT WITH GUARANTEED ULTRA PERFORMANCE: 15 second scan interval');
  bot.start();
}