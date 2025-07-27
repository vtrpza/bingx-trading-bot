import { bingxClient } from '../services/bingxClient';
import { wsManager } from '../services/websocket';
import { SignalGenerator } from './signalGenerator';
// import { TechnicalIndicators } from '../indicators/technicalIndicators';
import { logger } from '../utils/logger';
import Trade from '../models/Trade';
import { EventEmitter } from 'events';

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

  constructor() {
    super();
    this.config = {
      enabled: false,
      maxConcurrentTrades: parseInt(process.env.MAX_CONCURRENT_TRADES || '3'),
      defaultPositionSize: parseFloat(process.env.DEFAULT_POSITION_SIZE || '100'),
      scanInterval: 30000, // 30 seconds
      symbolsToScan: [],
      stopLossPercent: 2,
      takeProfitPercent: 3,
      trailingStopPercent: 1,
      minVolumeUSDT: 1000000 // 1M USDT minimum volume
    };

    this.signalGenerator = new SignalGenerator({
      minSignalStrength: 65,
      confirmationRequired: true
    });

    this.setupWebSocketListeners();
  }

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
      // Get all symbols
      const symbolsData = await bingxClient.getSymbols();
      
      if (!symbolsData.data || !Array.isArray(symbolsData.data)) {
        logger.error('Invalid symbols data received');
        return;
      }

      logger.debug(`Processing ${symbolsData.data.length} contracts for symbol list...`);

      // Filter active contracts and get their tickers for volume data
      const activeContracts = symbolsData.data.filter((contract: any) => {
        return contract.status === 1; // Active trading status
      });

      logger.debug(`Found ${activeContracts.length} active contracts`);

      // Get ticker data for volume filtering
      const symbolsWithVolume = [];
      
      for (const contract of activeContracts.slice(0, 50)) { // Limit to top 50 for performance
        try {
          const ticker = await bingxClient.getTicker(contract.symbol);
          if (ticker.code === 0 && ticker.data) {
            const volume = parseFloat(ticker.data.quoteVolume || 0);
            if (volume >= this.config.minVolumeUSDT) {
              symbolsWithVolume.push({
                symbol: contract.symbol,
                volume: volume
              });
            }
          }
        } catch (error) {
          logger.debug(`Failed to get ticker for ${contract.symbol}:`, error);
        }
      }

      // Sort by volume and take top symbols
      const eligibleSymbols = symbolsWithVolume
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 20) // Top 20 by volume
        .map(item => item.symbol);

      this.config.symbolsToScan = eligibleSymbols;
      logger.info(`Updated symbol list: ${eligibleSymbols.length} symbols`, {
        symbols: eligibleSymbols.slice(0, 5) // Log first 5 symbols
      });

    } catch (error) {
      logger.error('Failed to update symbol list:', error);
    }
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

    logger.debug(`Scanning ${this.config.symbolsToScan.length} symbols...`);

    for (const symbol of this.config.symbolsToScan) {
      try {
        // Skip if already have position in this symbol
        if (this.activePositions.has(symbol)) {
          continue;
        }

        // Get candle data
        const klines = await bingxClient.getKlines(symbol, '5m', 100);
        
        if (!klines.data || !Array.isArray(klines.data)) {
          continue;
        }

        // Convert to candle format
        const candles = klines.data.map((k: any) => ({
          timestamp: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5])
        }));

        // Generate signal
        const signal = this.signalGenerator.generateSignal(symbol, candles);
        
        this.emit('signal', signal);

        // Execute trade if signal is strong enough
        if (signal.action !== 'HOLD' && signal.strength >= 65) {
          await this.executeTrade(signal);
        }

      } catch (error) {
        logger.error(`Error scanning ${symbol}:`, error);
      }
    }
  }

  private async executeTrade(signal: any) {
    try {
      // Check if we can take more trades
      if (this.activePositions.size >= this.config.maxConcurrentTrades) {
        logger.warn('Cannot execute trade - max concurrent trades reached');
        return;
      }

      // Calculate position size
      const positionSize = this.config.defaultPositionSize;
      
      // Get current price
      const ticker = await bingxClient.getTicker(signal.symbol);
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

        this.emit('tradeExecuted', {
          symbol: signal.symbol,
          orderId: order.data.orderId,
          side: signal.action,
          quantity: orderData.quantity,
          price: currentPrice
        });

        logger.info(`Trade executed successfully: ${order.data.orderId}`);
      } else {
        logger.error('Failed to execute trade:', order);
      }

    } catch (error) {
      logger.error('Error executing trade:', error);
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
      symbolsCount: this.config.symbolsToScan.length
    };
  }

  updateConfig(config: Partial<BotConfig>) {
    this.config = { ...this.config, ...config };
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