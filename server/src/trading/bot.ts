import { bingxClient } from '../services/bingxClient';
import { wsManager } from '../services/websocket';
import { SignalGenerator } from './signalGenerator';
import { apiRequestManager, RequestPriority } from '../services/APIRequestManager';
// import { TechnicalIndicators } from '../indicators/technicalIndicators';
import { logger } from '../utils/logger';
import Trade from '../models/Trade';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

interface ProcessStep {
  id: string;
  name: string;
  status: 'idle' | 'processing' | 'completed' | 'error' | 'warning';
  startTime?: number;
  endTime?: number;
  duration?: number;
  metadata?: any;
  error?: string;
}

interface SignalInProcess {
  id: string;
  symbol: string;
  stage: 'analyzing' | 'evaluating' | 'decided' | 'queued' | 'executing' | 'completed' | 'rejected';
  signal?: any;
  startTime: number;
  decision?: 'execute' | 'reject';
  rejectionReason?: string;
  executionTime?: number;
}

interface TradeInQueue {
  id: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  estimatedPrice: number;
  priority: number;
  queueTime: number;
  status: 'queued' | 'processing' | 'executed' | 'failed';
  signalId?: string;
}

interface ProcessMetrics {
  scanningRate: number;
  signalGenerationRate: number;
  executionSuccessRate: number;
  averageProcessingTime: {
    scanning: number;
    analysis: number;
    decision: number;
    execution: number;
  };
  performance: {
    totalScanned: number;
    signalsGenerated: number;
    tradesExecuted: number;
    errors: number;
  };
  bottlenecks: string[];
}

interface ActivityEvent {
  id: string;
  type: 'scan_started' | 'signal_generated' | 'trade_executed' | 'error' | 'position_closed' | 'market_data_updated';
  symbol?: string;
  message: string;
  timestamp: number;
  level: 'info' | 'warning' | 'error' | 'success';
  metadata?: any;
}

interface BotConfig {
  enabled: boolean;
  maxConcurrentTrades: number;
  defaultPositionSize: number;
  scanInterval: number; // milliseconds
  symbolsToScan: string[];
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
}

interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  unrealizedPnl: number;
  orderId: string;
}

export class TradingBot extends EventEmitter {
  private config: BotConfig;
  private signalGenerator: SignalGenerator;
  private scanInterval: NodeJS.Timeout | null = null;
  private activePositions: Map<string, Position> = new Map();
  private isRunning: boolean = false;
  
  // Process tracking
  private currentStep: string = 'idle';
  private processSteps: Map<string, ProcessStep> = new Map();
  private activeSignals: Map<string, SignalInProcess> = new Map();
  private executionQueue: TradeInQueue[] = [];
  private activityEvents: ActivityEvent[] = [];
  private processMetrics!: ProcessMetrics;
  // private performanceTimers: Map<string, number> = new Map();

  constructor() {
    super();
    this.config = {
      enabled: false,
      maxConcurrentTrades: parseInt(process.env.MAX_CONCURRENT_TRADES || '3'),
      defaultPositionSize: parseFloat(process.env.DEFAULT_POSITION_SIZE || '100'),
      scanInterval: 300000, // 5 minutes - reduced to minimize API calls
      symbolsToScan: [],
      stopLossPercent: 2,
      takeProfitPercent: 3,
      trailingStopPercent: 1,
      minVolumeUSDT: 10000, // 10K USDT minimum volume (reduced to include more symbols)
      // Signal generation parameters (Balanced profile defaults)
      rsiOversold: 30,
      rsiOverbought: 70,
      volumeSpikeThreshold: 1.5,
      minSignalStrength: 65,
      confirmationRequired: true,
      ma1Period: 9,
      ma2Period: 21
    };

    this.signalGenerator = new SignalGenerator({
      rsiOversold: this.config.rsiOversold,
      rsiOverbought: this.config.rsiOverbought,
      volumeSpikeThreshold: this.config.volumeSpikeThreshold,
      minSignalStrength: this.config.minSignalStrength,
      confirmationRequired: this.config.confirmationRequired
    });

    // Initialize process tracking
    this.initializeProcessSteps();
    this.initializeMetrics();

    this.setupWebSocketListeners();
  }

  private initializeProcessSteps() {
    const steps = [
      { id: 'scanning', name: 'Market Scanning', status: 'idle' as const },
      { id: 'analysis', name: 'Signal Analysis', status: 'idle' as const },
      { id: 'decision', name: 'Decision Making', status: 'idle' as const },
      { id: 'execution', name: 'Trade Execution', status: 'idle' as const }
    ];

    steps.forEach(step => {
      this.processSteps.set(step.id, step);
    });
  }

  private initializeMetrics() {
    this.processMetrics = {
      scanningRate: 0,
      signalGenerationRate: 0,
      executionSuccessRate: 0,
      averageProcessingTime: {
        scanning: 0,
        analysis: 0,
        decision: 0,
        execution: 0
      },
      performance: {
        totalScanned: 0,
        signalsGenerated: 0,
        tradesExecuted: 0,
        errors: 0
      },
      bottlenecks: []
    };
  }

  private updateProcessStep(stepId: string, status: ProcessStep['status'], metadata?: any, error?: string) {
    const step = this.processSteps.get(stepId);
    if (!step) return;

    const now = Date.now();
    
    if (status === 'processing') {
      step.startTime = now;
    } else if (status === 'completed' || status === 'error') {
      step.endTime = now;
      if (step.startTime) {
        step.duration = step.endTime - step.startTime;
        this.updateAverageProcessingTime(stepId, step.duration);
      }
    }

    step.status = status;
    step.metadata = metadata;
    step.error = error;

    this.currentStep = stepId;
    this.emitProcessUpdate();

    if (status === 'error') {
      this.processMetrics.performance.errors++;
    }
  }

  private updateAverageProcessingTime(stepId: string, duration: number) {
    const metrics = this.processMetrics.averageProcessingTime;
    if (stepId in metrics) {
      // Simple moving average (could be improved with weighted average)
      const currentAvg = metrics[stepId as keyof typeof metrics];
      metrics[stepId as keyof typeof metrics] = currentAvg === 0 ? duration : (currentAvg + duration) / 2;
    }
  }

  private addActivityEvent(type: ActivityEvent['type'], message: string, level: ActivityEvent['level'] = 'info', symbol?: string, metadata?: any) {
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

  private emitProcessUpdate() {
    const flowState = {
      currentStep: this.currentStep,
      steps: Array.from(this.processSteps.values()),
      activeSignals: Array.from(this.activeSignals.values()),
      executionQueue: this.executionQueue,
      metrics: this.processMetrics,
      lastUpdate: Date.now()
    };

    this.emit('processUpdate', flowState);
  }

  // Performance timing methods (for future use)
  // private startTimer(operation: string): string {
  //   const timerId = `${operation}_${Date.now()}`;
  //   this.performanceTimers.set(timerId, Date.now());
  //   return timerId;
  // }

  // private endTimer(timerId: string): number {
  //   const startTime = this.performanceTimers.get(timerId);
  //   if (startTime) {
  //     this.performanceTimers.delete(timerId);
  //     return Date.now() - startTime;
  //   }
  //   return 0;
  // }

  private setupWebSocketListeners() {
    wsManager.on('orderUpdate', (data) => {
      this.handleOrderUpdate(data);
    });

    wsManager.on('accountUpdate', (data) => {
      this.handleAccountUpdate(data);
    });
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Trading bot is already running');
      return;
    }

    logger.info('Starting trading bot...');
    
    try {
      this.isRunning = true;
      this.emit('started');

      // Load active positions
      logger.info('Loading active positions...');
      await this.loadActivePositions();

      // Get top symbols by volume
      logger.info('Updating symbol list...');
      await this.updateSymbolList();

      // Start scanning
      logger.info('Starting symbol scanning...');
      this.startScanning();
      
      logger.info(`Trading bot started successfully. Scanning ${this.config.symbolsToScan.length} symbols every ${this.config.scanInterval}ms`);
    } catch (error) {
      logger.error('Failed to start trading bot:', error);
      this.isRunning = false;
      throw error;
    }
  }

  stop() {
    if (!this.isRunning) {
      logger.warn('Trading bot is already stopped');
      return;
    }

    logger.info('Stopping trading bot...');
    this.isRunning = false;

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
      logger.info('Symbol scanning stopped');
    }

    this.emit('stopped');
    logger.info('Trading bot stopped successfully');
  }

  private async updateSymbolList() {
    try {
      // Use predefined popular symbols for faster startup
      const popularSymbols = [
        'BTC-USDT', 'ETH-USDT', 'BNB-USDT', 'SOL-USDT', 'XRP-USDT',
        'ADA-USDT', 'DOGE-USDT', 'DOT-USDT', 'MATIC-USDT', 'AVAX-USDT',
        'LINK-USDT', 'UNI-USDT', 'LTC-USDT', 'BCH-USDT', 'ATOM-USDT'
      ];

      // Start with popular symbols immediately
      this.config.symbolsToScan = popularSymbols;
      logger.info(`Initialized with ${popularSymbols.length} popular symbols for immediate scanning`);

      // Async update with real data (don't await)
      this.updateSymbolListAsync().catch(error => {
        logger.error('Failed to update symbol list asynchronously:', error);
      });

    } catch (error) {
      logger.error('Failed to initialize symbol list:', error);
    }
  }

  private async updateSymbolListAsync() {
    try {
      logger.debug('Starting async symbol list update...');
      
      // Get all symbols with timeout
      const symbolsPromise = Promise.race([
        bingxClient.getSymbols(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Symbols fetch timeout')), 15000)
        )
      ]) as Promise<any>;

      const symbolsData = await symbolsPromise;
      
      if (!symbolsData.data || !Array.isArray(symbolsData.data)) {
        logger.warn('Invalid symbols data received, keeping current symbols');
        return;
      }

      // Filter active USDT contracts only
      const activeContracts = symbolsData.data
        .filter((contract: any) => 
          contract.status === 1 && // Active contracts only
          contract.symbol && 
          contract.symbol.endsWith('-USDT') // USDT pairs only
        );

      logger.debug(`Found ${activeContracts.length} active contracts for async update`);

      // Get volume data with limited concurrency
      const symbolsWithVolume = await this.getSymbolVolumes(activeContracts);

      if (symbolsWithVolume.length > 0) {
        // Sort by volume and filter by minimum volume (no hard limit on count)
        const eligibleSymbols = symbolsWithVolume
          .filter(item => item.volume >= this.config.minVolumeUSDT)
          .sort((a, b) => b.volume - a.volume)
          .map(item => item.symbol);

        this.config.symbolsToScan = eligibleSymbols;
        logger.info(`Updated symbol list with real volume data: ${eligibleSymbols.length} symbols`, {
          symbols: eligibleSymbols.slice(0, 5)
        });
      }

    } catch (error) {
      logger.warn('Async symbol update failed, keeping current symbols:', error instanceof Error ? error.message : String(error));
    }
  }

  private async getSymbolVolumes(contracts: any[], batchSize = 5): Promise<{symbol: string, volume: number}[]> {
    const symbolsWithVolume: {symbol: string, volume: number}[] = [];
    
    // Process in small batches to avoid overwhelming the API
    for (let i = 0; i < contracts.length; i += batchSize) {
      const batch = contracts.slice(i, i + batchSize);
      
      const promises = batch.map(async (contract) => {
        try {
          // Use LOW priority for background volume scanning to avoid queue conflicts
          const ticker: any = await apiRequestManager.getTicker(contract.symbol, RequestPriority.LOW);
          if (ticker.code === 0 && ticker.data) {
            const volume = parseFloat(ticker.data.quoteVolume || 0);
            if (volume >= this.config.minVolumeUSDT) {
              return { symbol: contract.symbol, volume };
            }
          }
        } catch (error) {
          logger.debug(`Failed to get ticker for ${contract.symbol}:`, error instanceof Error ? error.message : String(error));
        }
        return null;
      });

      const results = await Promise.allSettled(promises);
      
      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          symbolsWithVolume.push(result.value);
        }
      });

      // Small delay between batches
      if (i + batchSize < contracts.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return symbolsWithVolume;
  }

  private startScanning() {
    // Initial scan
    this.scanSymbols();

    // Set up interval
    this.scanInterval = setInterval(() => {
      if (this.isRunning) {
        this.scanSymbols();
      }
    }, this.config.scanInterval);
  }

  private async scanSymbols() {
    if (this.activePositions.size >= this.config.maxConcurrentTrades) {
      logger.debug('Max concurrent trades reached, skipping scan');
      return;
    }

    const symbolsToScan = this.config.symbolsToScan.filter(symbol => 
      !this.activePositions.has(symbol)
    );

    logger.debug(`Scanning ${symbolsToScan.length} symbols (${this.activePositions.size} positions active)...`);
    
    // Start scanning process tracking
    this.updateProcessStep('scanning', 'processing', { symbolsCount: symbolsToScan.length });
    this.addActivityEvent('scan_started', `Starting scan of ${symbolsToScan.length} symbols`, 'info');

    if (symbolsToScan.length === 0) {
      logger.debug('No new symbols to scan');
      this.updateProcessStep('scanning', 'completed', { symbolsCount: 0 });
      return;
    }

    // Process symbols in batches with timeout protection
    const batchSize = 3;
    const timeout = 25000; // 25 seconds timeout
    
    try {
      await Promise.race([
        this.procesSymbolBatches(symbolsToScan, batchSize),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Symbol scanning timeout')), timeout)
        )
      ]);
      
      this.updateProcessStep('scanning', 'completed', { 
        symbolsScanned: symbolsToScan.length,
        duration: this.processSteps.get('scanning')?.duration 
      });
      this.processMetrics.performance.totalScanned += symbolsToScan.length;
      
    } catch (error) {
      logger.warn('Symbol scanning completed with timeout:', error instanceof Error ? error.message : String(error));
      this.updateProcessStep('scanning', 'error', { symbolsCount: symbolsToScan.length }, error instanceof Error ? error.message : String(error));
      this.addActivityEvent('error', `Scanning failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  }

  private async procesSymbolBatches(symbols: string[], batchSize: number) {
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      
      // Process batch concurrently
      const promises = batch.map(symbol => this.scanSingleSymbol(symbol));
      
      try {
        await Promise.allSettled(promises);
      } catch (error) {
        logger.debug(`Batch ${i/batchSize + 1} completed with some errors`);
      }

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  private async scanSingleSymbol(symbol: string): Promise<void> {
    try {
      // Individual symbol timeout
      const symbolTimeout = 8000; // 8 seconds per symbol
      
      await Promise.race([
        this.processSymbolSignal(symbol),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Symbol ${symbol} timeout`)), symbolTimeout)
        )
      ]);

    } catch (error) {
      logger.debug(`Error scanning ${symbol}:`, error instanceof Error ? error.message : String(error));
    }
  }

  private async processSymbolSignal(symbol: string): Promise<void> {
    const signalId = uuidv4();
    
    try {
      // Start signal processing tracking
      const signalInProcess: SignalInProcess = {
        id: signalId,
        symbol,
        stage: 'analyzing',
        startTime: Date.now()
      };
      
      this.activeSignals.set(signalId, signalInProcess);
      this.updateProcessStep('analysis', 'processing', { symbol, signalId });
      
      // Get candle data with error handling
      const klines = await bingxClient.getKlines(symbol, '5m', 100);
      
      if (!klines || klines.code !== 0 || !klines.data || !Array.isArray(klines.data)) {
        logger.debug(`No valid klines data for ${symbol}: ${klines?.code || 'unknown error'}`);
        signalInProcess.stage = 'rejected';
        signalInProcess.rejectionReason = 'No valid market data';
        this.activeSignals.delete(signalId);
        return;
      }

      if (klines.data.length < 50) {
        logger.debug(`Insufficient klines data for ${symbol}: ${klines.data.length} candles`);
        signalInProcess.stage = 'rejected';
        signalInProcess.rejectionReason = 'Insufficient historical data';
        this.activeSignals.delete(signalId);
        return;
      }

      // Convert to candle format with validation
      const candles = klines.data.map((k: any, index: number) => {
        const candle = {
          timestamp: parseInt(k.time || k[0]),
          open: parseFloat(k.open !== undefined ? k.open : k[1]),
          high: parseFloat(k.high !== undefined ? k.high : k[2]),
          low: parseFloat(k.low !== undefined ? k.low : k[3]),
          close: parseFloat(k.close !== undefined ? k.close : k[4]),
          volume: parseFloat(k.volume !== undefined ? k.volume : k[5])
        };
        
        // Validate candle data with detailed error reporting
        const validationErrors = [];
        if (isNaN(candle.open)) validationErrors.push(`open: ${k.open} -> ${candle.open}`);
        if (isNaN(candle.high)) validationErrors.push(`high: ${k.high} -> ${candle.high}`);
        if (isNaN(candle.low)) validationErrors.push(`low: ${k.low} -> ${candle.low}`);
        if (isNaN(candle.close)) validationErrors.push(`close: ${k.close} -> ${candle.close}`);
        if (isNaN(candle.volume)) validationErrors.push(`volume: ${k.volume} -> ${candle.volume}`);
        if (candle.open <= 0) validationErrors.push(`open <= 0: ${candle.open}`);
        if (candle.high <= 0) validationErrors.push(`high <= 0: ${candle.high}`);
        if (candle.low <= 0) validationErrors.push(`low <= 0: ${candle.low}`);
        if (candle.close <= 0) validationErrors.push(`close <= 0: ${candle.close}`);
        
        // Validate OHLC relationships
        if (candle.high < candle.low) validationErrors.push(`high < low: ${candle.high} < ${candle.low}`);
        if (candle.high < Math.max(candle.open, candle.close)) {
          validationErrors.push(`high < max(open,close): ${candle.high} < ${Math.max(candle.open, candle.close)}`);
        }
        if (candle.low > Math.min(candle.open, candle.close)) {
          validationErrors.push(`low > min(open,close): ${candle.low} > ${Math.min(candle.open, candle.close)}`);
        }
        
        if (validationErrors.length > 0) {
          logger.warn(`Invalid candle data at index ${index} for ${symbol}: ${validationErrors.join(', ')}`, {
            raw: k,
            parsed: candle
          });
          return null;
        }
        
        return candle;
      }).filter((candle: any): candle is {timestamp: number, open: number, high: number, low: number, close: number, volume: number} => candle !== null);

      if (candles.length < 50) {
        logger.debug(`Insufficient valid candles for ${symbol}: ${candles.length} valid candles`);
        return;
      }

      // Update signal processing stage
      signalInProcess.stage = 'evaluating';
      
      // Generate signal with MA period configuration
      const signal = this.signalGenerator.generateSignal(symbol, candles, {
        ma1Period: this.config.ma1Period,
        ma2Period: this.config.ma2Period
      });
      
      signalInProcess.signal = signal;
      signalInProcess.stage = 'decided';
      
      this.emit('signal', signal);
      this.addActivityEvent('signal_generated', `${signal.action} signal for ${symbol} (${signal.strength}%)`, 'info', symbol, { signalId, strength: signal.strength });
      this.processMetrics.performance.signalsGenerated++;
      
      // Decision making process
      this.updateProcessStep('decision', 'processing', { symbol, signal: signal.action, strength: signal.strength });
      
      // Execute trade if signal is strong enough
      if (signal.action !== 'HOLD' && signal.strength >= 65) {
        signalInProcess.decision = 'execute';
        signalInProcess.stage = 'queued';
        
        // Add to execution queue
        const tradeInQueue: TradeInQueue = {
          id: uuidv4(),
          symbol,
          action: signal.action as 'BUY' | 'SELL',
          quantity: this.config.defaultPositionSize,
          estimatedPrice: signal.indicators.price,
          priority: signal.strength,
          queueTime: Date.now(),
          status: 'queued',
          signalId
        };
        
        this.executionQueue.push(tradeInQueue);
        this.updateProcessStep('decision', 'completed', { decision: 'execute', queuePosition: this.executionQueue.length });
        this.addActivityEvent('trade_executed', `Trade queued for execution: ${signal.action} ${symbol}`, 'success', symbol, { signalId, tradeId: tradeInQueue.id });
        
        await this.executeTrade(signal, signalId, tradeInQueue.id);
      } else {
        signalInProcess.decision = 'reject';
        signalInProcess.rejectionReason = signal.action === 'HOLD' ? 'No clear signal' : `Signal strength too low (${signal.strength}%)`;
        signalInProcess.stage = 'rejected';
        this.updateProcessStep('decision', 'completed', { decision: 'reject', reason: signalInProcess.rejectionReason });
        this.activeSignals.delete(signalId);
      }
      
    } catch (error) {
      logger.debug(`Error processing signal for ${symbol}:`, {
        error: error instanceof Error ? error.message : error
      });
      
      const signalInProcess = this.activeSignals.get(signalId);
      if (signalInProcess) {
        signalInProcess.stage = 'rejected';
        signalInProcess.rejectionReason = error instanceof Error ? error.message : 'Unknown error';
        this.activeSignals.delete(signalId);
      }
      
      this.updateProcessStep('analysis', 'error', { symbol }, error instanceof Error ? error.message : String(error));
      this.addActivityEvent('error', `Signal processing failed for ${symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error', symbol);
    }
  }

  private async executeTrade(signal: any, signalId?: string, tradeId?: string) {
    try {
      this.updateProcessStep('execution', 'processing', { symbol: signal.symbol, signalId, tradeId });
      
      // Update trade queue status
      if (tradeId) {
        const tradeInQueue = this.executionQueue.find(t => t.id === tradeId);
        if (tradeInQueue) {
          tradeInQueue.status = 'processing';
        }
      }
      
      // Check if we can take more trades
      if (this.activePositions.size >= this.config.maxConcurrentTrades) {
        logger.warn('Cannot execute trade - max concurrent trades reached');
        
        if (signalId) {
          const signalInProcess = this.activeSignals.get(signalId);
          if (signalInProcess) {
            signalInProcess.stage = 'rejected';
            signalInProcess.rejectionReason = 'Max concurrent trades reached';
            this.activeSignals.delete(signalId);
          }
        }
        
        if (tradeId) {
          const tradeIndex = this.executionQueue.findIndex(t => t.id === tradeId);
          if (tradeIndex !== -1) {
            this.executionQueue[tradeIndex].status = 'failed';
          }
        }
        
        this.updateProcessStep('execution', 'error', { symbol: signal.symbol }, 'Max concurrent trades reached');
        return;
      }

      // Calculate position size
      const positionSize = this.config.defaultPositionSize;
      
      // Get current price with HIGH priority for trade execution
      const ticker: any = await apiRequestManager.getTicker(signal.symbol, RequestPriority.HIGH);
      const currentPrice = parseFloat(ticker.data.lastPrice);
      
      // Calculate quantity
      const quantity = positionSize / currentPrice;
      
      // Calculate stop loss and take profit
      const stopLoss = signal.action === 'BUY' 
        ? currentPrice * (1 - this.config.stopLossPercent / 100)
        : currentPrice * (1 + this.config.stopLossPercent / 100);
        
      const takeProfit = signal.action === 'BUY'
        ? currentPrice * (1 + this.config.takeProfitPercent / 100)
        : currentPrice * (1 - this.config.takeProfitPercent / 100);

      // Place order
      const orderData = {
        symbol: signal.symbol,
        side: signal.action as 'BUY' | 'SELL',
        positionSide: signal.action === 'BUY' ? 'LONG' : 'SHORT' as 'LONG' | 'SHORT',
        type: 'MARKET' as const,
        quantity: parseFloat(quantity.toFixed(3)),
        stopLoss: parseFloat(stopLoss.toFixed(2)),
        takeProfit: parseFloat(takeProfit.toFixed(2))
      };

      logger.info(`Executing ${signal.action} order for ${signal.symbol}`, orderData);
      
      const order = await bingxClient.placeOrder(orderData);
      
      if (order.code === 0 && order.data) {
        // Save to database
        await Trade.create({
          orderId: order.data.orderId,
          symbol: signal.symbol,
          side: signal.action,
          positionSide: orderData.positionSide,
          type: 'MARKET',
          status: 'NEW',
          quantity: orderData.quantity,
          price: currentPrice,
          stopLossPrice: stopLoss,
          takeProfitPrice: takeProfit,
          signalStrength: signal.strength,
          signalReason: signal.reason,
          indicators: signal.indicators,
          commissionAsset: 'USDT',
          commission: 0,
          executedQty: 0,
          avgPrice: 0,
          realizedPnl: 0
        });

        // Add to active positions
        this.activePositions.set(signal.symbol, {
          symbol: signal.symbol,
          side: orderData.positionSide,
          entryPrice: currentPrice,
          quantity: orderData.quantity,
          unrealizedPnl: 0,
          orderId: order.data.orderId
        });

        // Update tracking
        if (signalId) {
          const signalInProcess = this.activeSignals.get(signalId);
          if (signalInProcess) {
            signalInProcess.stage = 'completed';
            signalInProcess.executionTime = Date.now() - signalInProcess.startTime;
            this.activeSignals.delete(signalId);
          }
        }
        
        if (tradeId) {
          const tradeIndex = this.executionQueue.findIndex(t => t.id === tradeId);
          if (tradeIndex !== -1) {
            this.executionQueue[tradeIndex].status = 'executed';
          }
        }

        this.emit('tradeExecuted', {
          symbol: signal.symbol,
          orderId: order.data.orderId,
          side: signal.action,
          quantity: orderData.quantity,
          price: currentPrice
        });

        this.updateProcessStep('execution', 'completed', { 
          symbol: signal.symbol, 
          orderId: order.data.orderId,
          side: signal.action,
          price: currentPrice
        });
        
        this.processMetrics.performance.tradesExecuted++;
        this.addActivityEvent('trade_executed', `Trade executed: ${signal.action} ${signal.symbol} at $${currentPrice}`, 'success', signal.symbol, { 
          orderId: order.data.orderId,
          signalId,
          tradeId
        });

        logger.info(`Trade executed successfully: ${order.data.orderId}`);
      } else {
        logger.error('Failed to execute trade:', order);
        
        // Update tracking for failed execution
        if (signalId) {
          const signalInProcess = this.activeSignals.get(signalId);
          if (signalInProcess) {
            signalInProcess.stage = 'rejected';
            signalInProcess.rejectionReason = 'Order execution failed';
            this.activeSignals.delete(signalId);
          }
        }
        
        if (tradeId) {
          const tradeIndex = this.executionQueue.findIndex(t => t.id === tradeId);
          if (tradeIndex !== -1) {
            this.executionQueue[tradeIndex].status = 'failed';
          }
        }
        
        this.updateProcessStep('execution', 'error', { symbol: signal.symbol }, 'Order execution failed');
        this.addActivityEvent('error', `Trade execution failed for ${signal.symbol}: Order rejected`, 'error', signal.symbol);
      }

    } catch (error) {
      logger.error('Error executing trade:', error);
      
      // Update tracking for error
      if (signalId) {
        const signalInProcess = this.activeSignals.get(signalId);
        if (signalInProcess) {
          signalInProcess.stage = 'rejected';
          signalInProcess.rejectionReason = error instanceof Error ? error.message : 'Unknown error';
          this.activeSignals.delete(signalId);
        }
      }
      
      if (tradeId) {
        const tradeIndex = this.executionQueue.findIndex(t => t.id === tradeId);
        if (tradeIndex !== -1) {
          this.executionQueue[tradeIndex].status = 'failed';
        }
      }
      
      this.updateProcessStep('execution', 'error', { symbol: signal.symbol }, error instanceof Error ? error.message : String(error));
      this.addActivityEvent('error', `Trade execution error for ${signal.symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error', signal.symbol);
    }
  }

  private async loadActivePositions() {
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

  private async handleOrderUpdate(data: any) {
    // Handle order updates from WebSocket
    if (data.o) {
      const order = data.o;
      const symbol = order.s;
      
      if (order.X === 'FILLED') {
        logger.info(`Order filled: ${order.i} for ${symbol}`);
        
        // Update database
        await Trade.update(
          { 
            status: 'FILLED',
            executedQty: order.z,
            avgPrice: order.ap,
            executedAt: new Date()
          },
          { where: { orderId: order.i } }
        );
      }
    }
  }

  private async handleAccountUpdate(data: any) {
    // Handle account updates from WebSocket
    if (data.a && data.a.P) {
      data.a.P.forEach((position: any) => {
        const symbol = position.s;
        const amount = parseFloat(position.pa);
        
        if (amount === 0 && this.activePositions.has(symbol)) {
          // Position closed
          this.activePositions.delete(symbol);
          logger.info(`Position closed for ${symbol}`);
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

  getStatus() {
    return {
      isRunning: this.isRunning,
      activePositions: Array.from(this.activePositions.values()),
      config: this.config,
      symbolsCount: this.config.symbolsToScan.length,
      scannedSymbols: this.config.symbolsToScan
    };
  }

  getScannedSymbols(): string[] {
    return [...this.config.symbolsToScan];
  }

  getFlowState() {
    return {
      currentStep: this.currentStep,
      steps: Array.from(this.processSteps.values()),
      activeSignals: Array.from(this.activeSignals.values()),
      executionQueue: this.executionQueue,
      metrics: this.processMetrics,
      lastUpdate: Date.now()
    };
  }

  getActivityEvents(limit: number = 50) {
    return this.activityEvents.slice(0, limit);
  }

  getProcessMetrics() {
    return { ...this.processMetrics };
  }

  updateConfig(config: Partial<BotConfig>) {
    this.config = { ...this.config, ...config };
    
    // Update signal generator if any signal-related parameters changed
    const signalParams = ['rsiOversold', 'rsiOverbought', 'volumeSpikeThreshold', 'minSignalStrength', 'confirmationRequired'];
    if (signalParams.some(param => param in config)) {
      this.signalGenerator.updateConfig({
        rsiOversold: this.config.rsiOversold,
        rsiOverbought: this.config.rsiOverbought,
        volumeSpikeThreshold: this.config.volumeSpikeThreshold,
        minSignalStrength: this.config.minSignalStrength,
        confirmationRequired: this.config.confirmationRequired
      });
      logger.info('Signal generator configuration updated');
    }
    
    logger.info('Bot configuration updated');
  }
}

// Export singleton instance
let botInstance: TradingBot | null = null;

export function getTradingBot(): TradingBot {
  if (!botInstance) {
    botInstance = new TradingBot();
  }
  return botInstance;
}

export function startTradingBot() {
  const bot = getTradingBot();
  bot.start();
}