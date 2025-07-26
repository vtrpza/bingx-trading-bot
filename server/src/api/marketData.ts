import { Router } from 'express';
import { bingxClient } from '../services/bingxClient';
import { wsManager } from '../services/websocket';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { TechnicalIndicators } from '../indicators/technicalIndicators';
import { SignalGenerator } from '../trading/signalGenerator';

const router = Router();

// Get ticker data for a symbol
router.get('/ticker/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  
  try {
    const ticker = await bingxClient.getTicker(symbol);
    
    if (ticker.code === 0 && ticker.data) {
      res.json({
        success: true,
        data: ticker.data
      });
    } else {
      throw new AppError('Failed to fetch ticker data', 500);
    }
  } catch (error) {
    logger.error(`Failed to get ticker for ${symbol}:`, error);
    throw new AppError('Failed to fetch ticker data', 500);
  }
}));

// Get kline/candlestick data
router.get('/klines/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const { interval = '5m', limit = '100' } = req.query;
  
  try {
    const klines = await bingxClient.getKlines(
      symbol, 
      interval as string, 
      parseInt(limit as string)
    );
    
    if (klines.code === 0 && klines.data) {
      // Format klines data
      const formattedKlines = klines.data.map((k: any) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
        quoteVolume: parseFloat(k[7]),
        trades: k[8]
      }));
      
      res.json({
        success: true,
        data: formattedKlines
      });
    } else {
      throw new AppError('Failed to fetch kline data', 500);
    }
  } catch (error) {
    logger.error(`Failed to get klines for ${symbol}:`, error);
    throw new AppError('Failed to fetch kline data', 500);
  }
}));

// Get order book depth
router.get('/depth/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const { limit = '20' } = req.query;
  
  try {
    const depth = await bingxClient.getDepth(symbol, parseInt(limit as string));
    
    if (depth.code === 0 && depth.data) {
      res.json({
        success: true,
        data: depth.data
      });
    } else {
      throw new AppError('Failed to fetch depth data', 500);
    }
  } catch (error) {
    logger.error(`Failed to get depth for ${symbol}:`, error);
    throw new AppError('Failed to fetch depth data', 500);
  }
}));

// Calculate technical indicators
router.get('/indicators/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const { 
    interval = '5m', 
    limit = '100',
    ma1Period = '9',
    ma2Period = '21',
    rsiPeriod = '14'
  } = req.query;
  
  try {
    // Get kline data
    const klines = await bingxClient.getKlines(
      symbol, 
      interval as string, 
      parseInt(limit as string)
    );
    
    if (klines.code !== 0 || !klines.data) {
      throw new AppError('Failed to fetch kline data', 500);
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
    
    // Calculate indicators
    const indicators = TechnicalIndicators.calculateAllIndicators(candles, {
      maPeriod1: parseInt(ma1Period as string),
      maPeriod2: parseInt(ma2Period as string),
      rsiPeriod: parseInt(rsiPeriod as string)
    });
    
    res.json({
      success: true,
      data: {
        symbol,
        interval,
        indicators: indicators.latestValues,
        crossovers: indicators.crossovers,
        volumeAnalysis: indicators.volumeAnalysis,
        validation: indicators.validation,
        series: {
          timestamps: candles.map(c => c.timestamp),
          prices: candles.map(c => c.close),
          ma1: indicators.ma1,
          ma2: indicators.ma2,
          rsi: indicators.rsi,
          volumes: candles.map(c => c.volume)
        }
      }
    });
  } catch (error) {
    logger.error(`Failed to calculate indicators for ${symbol}:`, error);
    throw new AppError('Failed to calculate indicators', 500);
  }
}));

// Generate trading signal
router.get('/signal/:symbol', asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const { interval = '5m', limit = '100' } = req.query;
  
  try {
    // Get kline data
    const klines = await bingxClient.getKlines(
      symbol, 
      interval as string, 
      parseInt(limit as string)
    );
    
    if (klines.code !== 0 || !klines.data) {
      throw new AppError('Failed to fetch kline data', 500);
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
    const signalGenerator = new SignalGenerator();
    const signal = signalGenerator.generateSignal(symbol, candles);
    
    res.json({
      success: true,
      data: signal
    });
  } catch (error) {
    logger.error(`Failed to generate signal for ${symbol}:`, error);
    throw new AppError('Failed to generate signal', 500);
  }
}));

// Subscribe to WebSocket streams
router.post('/subscribe', asyncHandler(async (req, res) => {
  const { symbol, type, interval } = req.body;
  
  if (!symbol || !type) {
    throw new AppError('Symbol and type are required', 400);
  }
  
  try {
    wsManager.subscribe({
      symbol,
      type,
      interval
    });
    
    res.json({
      success: true,
      data: {
        message: 'Subscribed successfully',
        subscription: { symbol, type, interval }
      }
    });
  } catch (error) {
    logger.error('Failed to subscribe:', error);
    throw new AppError('Failed to subscribe to market data', 500);
  }
}));

// Unsubscribe from WebSocket streams
router.post('/unsubscribe', asyncHandler(async (req, res) => {
  const { symbol, type, interval } = req.body;
  
  if (!symbol || !type) {
    throw new AppError('Symbol and type are required', 400);
  }
  
  try {
    wsManager.unsubscribe({
      symbol,
      type,
      interval
    });
    
    res.json({
      success: true,
      data: {
        message: 'Unsubscribed successfully',
        subscription: { symbol, type, interval }
      }
    });
  } catch (error) {
    logger.error('Failed to unsubscribe:', error);
    throw new AppError('Failed to unsubscribe from market data', 500);
  }
}));

// Get market overview
router.get('/overview', asyncHandler(async (req, res) => {
  try {
    // Get all symbols
    const symbolsData = await bingxClient.getSymbols();
    
    if (symbolsData.code !== 0 || !symbolsData.data) {
      throw new AppError('Failed to fetch market data', 500);
    }
    
    // Get top movers
    const tickers = await Promise.all(
      symbolsData.data
        .filter((s: any) => s.contractType === 'PERPETUAL' && s.status === 'TRADING')
        .slice(0, 50) // Limit to top 50 to avoid too many requests
        .map(async (symbol: any) => {
          try {
            const ticker = await bingxClient.getTicker(symbol.symbol);
            if (ticker.code === 0 && ticker.data) {
              return {
                symbol: symbol.symbol,
                lastPrice: parseFloat(ticker.data.lastPrice),
                priceChangePercent: parseFloat(ticker.data.priceChangePercent),
                volume: parseFloat(ticker.data.quoteVolume)
              };
            }
            return null;
          } catch (error) {
            return null;
          }
        })
    );
    
    const validTickers = tickers.filter(t => t !== null);
    
    // Sort by different criteria
    const topGainers = [...validTickers]
      .sort((a, b) => b!.priceChangePercent - a!.priceChangePercent)
      .slice(0, 5);
      
    const topLosers = [...validTickers]
      .sort((a, b) => a!.priceChangePercent - b!.priceChangePercent)
      .slice(0, 5);
      
    const topVolume = [...validTickers]
      .sort((a, b) => b!.volume - a!.volume)
      .slice(0, 5);
    
    res.json({
      success: true,
      data: {
        topGainers,
        topLosers,
        topVolume,
        totalSymbols: symbolsData.data.length,
        activeSymbols: symbolsData.data.filter((s: any) => s.status === 'TRADING').length
      }
    });
  } catch (error) {
    logger.error('Failed to get market overview:', error);
    throw new AppError('Failed to get market overview', 500);
  }
}));

export default router;