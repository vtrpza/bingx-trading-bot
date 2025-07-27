import { Router, Request, Response } from 'express';
import { bingxClient } from '../services/bingxClient';
import { wsManager } from '../services/websocket';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { TechnicalIndicators } from '../indicators/technicalIndicators';
import { SignalGenerator } from '../trading/signalGenerator';
import { symbolCache } from '../services/symbolCache';

// Dynamic symbol validation using BingX live data
async function validateAndFormatSymbol(symbol: string): Promise<string> {
  if (!symbol) {
    throw new AppError('Symbol is required', 400);
  }
  
  // Use dynamic symbol validation
  const validation = await symbolCache.validateSymbolWithSuggestions(symbol);
  
  if (validation.isValid && validation.symbol) {
    return validation.symbol;
  }
  
  // Symbol not found - provide helpful error with suggestions
  const errorMessage = validation.message || `Symbol "${symbol}" not found`;
  const suggestions = validation.suggestions ? ` Suggestions: ${validation.suggestions.join(', ')}` : '';
  
  logger.warn(`Invalid symbol requested: ${symbol}${suggestions}`);
  throw new AppError(`${errorMessage}${suggestions}`, 404);
}

const router = Router();

// Get ticker data for a symbol
router.get('/ticker/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const rawSymbol = req.params.symbol;
  const symbol = await validateAndFormatSymbol(rawSymbol);
  
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
router.get('/klines/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const rawSymbol = req.params.symbol;
  const symbol = await validateAndFormatSymbol(rawSymbol);
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
        timestamp: parseInt(k.time || k[0]),
        open: parseFloat(k.open !== undefined ? k.open : k[1]),
        high: parseFloat(k.high !== undefined ? k.high : k[2]),
        low: parseFloat(k.low !== undefined ? k.low : k[3]),
        close: parseFloat(k.close !== undefined ? k.close : k[4]),
        volume: parseFloat(k.volume !== undefined ? k.volume : k[5]),
        closeTime: k.closeTime || k[6],
        quoteVolume: parseFloat(k.quoteVolume || k[7]),
        trades: k.trades || k[8]
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
router.get('/depth/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const rawSymbol = req.params.symbol;
  const symbol = await validateAndFormatSymbol(rawSymbol);
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
router.get('/indicators/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const rawSymbol = req.params.symbol;
  const symbol = await validateAndFormatSymbol(rawSymbol);
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
        timestamp: parseInt(k.time || k[0]),
        open: parseFloat(k.open !== undefined ? k.open : k[1]),
        high: parseFloat(k.high !== undefined ? k.high : k[2]),
        low: parseFloat(k.low !== undefined ? k.low : k[3]),
        close: parseFloat(k.close !== undefined ? k.close : k[4]),
        volume: parseFloat(k.volume !== undefined ? k.volume : k[5])
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
          timestamps: candles.map((c: any) => c.timestamp),
          prices: candles.map((c: any) => c.close),
          ma1: indicators.ma1,
          ma2: indicators.ma2,
          rsi: indicators.rsi,
          volumes: candles.map((c: any) => c.volume)
        }
      }
    });
  } catch (error) {
    logger.error(`Failed to calculate indicators for ${symbol}:`, error);
    throw new AppError('Failed to calculate indicators', 500);
  }
}));

// Generate trading signal
router.get('/signal/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const rawSymbol = req.params.symbol;
  const symbol = await validateAndFormatSymbol(rawSymbol);
  const { interval = '5m', limit = '100' } = req.query;
  
  try {
    logger.debug(`Generating signal for ${symbol} with interval ${interval} and limit ${limit}`);
    
    // Get kline data
    const klines = await bingxClient.getKlines(
      symbol, 
      interval as string, 
      parseInt(limit as string)
    );
    
    logger.debug(`Klines response for ${symbol}:`, { 
      code: klines.code, 
      dataLength: klines.data?.length,
      hasData: !!klines.data 
    });
    
    if (klines.code !== 0 || !klines.data) {
      logger.error(`Failed to fetch klines for ${symbol}:`, { code: klines.code, msg: klines.msg });
      throw new AppError(`Failed to fetch kline data: ${klines.msg || 'Unknown error'}`, 500);
    }
    
    if (klines.data.length === 0) {
      logger.warn(`No kline data available for ${symbol}`);
      throw new AppError('No market data available for this symbol', 404);
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
      
      // Validate candle data
      if (isNaN(candle.open) || isNaN(candle.high) || isNaN(candle.low) || isNaN(candle.close) || isNaN(candle.volume)) {
        logger.warn(`Invalid candle data at index ${index} for ${symbol}:`, k);
        return null;
      }
      
      return candle;
    }).filter((candle: any) => candle !== null);
    
    logger.debug(`Processed ${candles.length} valid candles for ${symbol}`);
    
    if (candles.length < 50) {
      logger.warn(`Insufficient candle data for ${symbol}: ${candles.length} candles`);
      // Still generate signal but note the limitation
    }
    
    // Generate signal
    const signalGenerator = new SignalGenerator();
    const signal = signalGenerator.generateSignal(symbol, candles as any);
    
    logger.debug(`Generated signal for ${symbol}:`, { 
      action: signal.action, 
      strength: signal.strength, 
      reason: signal.reason 
    });
    
    res.json({
      success: true,
      data: signal
    });
  } catch (error) {
    logger.error(`Failed to generate signal for ${symbol}:`, error);
    
    // Return a meaningful error response instead of throwing
    if (error instanceof AppError) {
      throw error;
    }
    
    throw new AppError(`Signal generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 500);
  }
}));

// Subscribe to WebSocket streams
router.post('/subscribe', asyncHandler(async (req: Request, res: Response) => {
  const { symbol: rawSymbol, type, interval } = req.body;
  const symbol = rawSymbol ? await validateAndFormatSymbol(rawSymbol) : undefined;
  
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
router.post('/unsubscribe', asyncHandler(async (req: Request, res: Response) => {
  const { symbol: rawSymbol, type, interval } = req.body;
  const symbol = rawSymbol ? await validateAndFormatSymbol(rawSymbol) : undefined;
  
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

// Cache for market overview to avoid rate limiting
let marketOverviewCache: any = null;
let marketOverviewCacheTime: number = 0;
const CACHE_DURATION = 60000; // 1 minute cache

// Get market overview
router.get('/overview', asyncHandler(async (_req: Request, res: Response) => {
  try {
    // Check cache first
    const now = Date.now();
    if (marketOverviewCache && (now - marketOverviewCacheTime) < CACHE_DURATION) {
      res.json({
        success: true,
        data: marketOverviewCache
      });
      return;
    }

    // Get all symbols
    const symbolsData = await bingxClient.getSymbols();
    
    if (symbolsData.code !== 0 || !symbolsData.data) {
      throw new AppError('Failed to fetch market data', 500);
    }
    
    // Get popular symbols dynamically from BingX
    const popularSymbols = await symbolCache.getPopularSymbols(10);
    
    // Get tickers for popular symbols with proper rate limiting
    const tickers = [];
    
    // Process symbols in smaller batches to respect rate limits
    const batchSize = 3; // Process 3 symbols at a time
    for (let i = 0; i < popularSymbols.length; i += batchSize) {
      const batch = popularSymbols.slice(i, i + batchSize);
      
      // Process each symbol in the batch with proper delay
      for (const symbol of batch) {
        try {
          const ticker = await bingxClient.getTicker(symbol);
          if (ticker.code === 0 && ticker.data) {
            tickers.push({
              symbol: symbol,
              lastPrice: parseFloat(ticker.data.lastPrice),
              priceChangePercent: parseFloat(ticker.data.priceChangePercent),
              volume: parseFloat(ticker.data.quoteVolume)
            });
          }
        } catch (error) {
          logger.error(`Failed to get ticker for ${symbol}:`, error);
          // Continue with next symbol on error
        }
      }
      
      // Longer delay between batches to ensure rate limit compliance
      if (i + batchSize < popularSymbols.length) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    
    const validTickers = tickers;
    
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
    
    // Cache the result
    marketOverviewCache = {
      topGainers,
      topLosers,
      topVolume,
      totalSymbols: symbolsData.data.length,
      activeSymbols: symbolsData.data.filter((s: any) => s.status === 'TRADING').length
    };
    marketOverviewCacheTime = now;
    
    res.json({
      success: true,
      data: marketOverviewCache
    });
  } catch (error) {
    logger.error('Failed to get market overview:', error);
    throw new AppError('Failed to get market overview', 500);
  }
}));

// Get available symbols endpoint
router.get('/symbols', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const validSymbols = await symbolCache.getValidSymbols();
    const stats = symbolCache.getStats();
    
    res.json({
      success: true,
      data: {
        symbols: validSymbols,
        total: validSymbols.length,
        stats
      }
    });
  } catch (error) {
    logger.error('Failed to get symbols:', error);
    throw new AppError('Failed to fetch symbols', 500);
  }
}));

// Symbol validation endpoint  
router.get('/validate/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const rawSymbol = req.params.symbol;
  
  try {
    const validation = await symbolCache.validateSymbolWithSuggestions(rawSymbol);
    
    res.json({
      success: true,
      data: validation
    });
  } catch (error) {
    logger.error(`Failed to validate symbol ${rawSymbol}:`, error);
    throw new AppError('Failed to validate symbol', 500);
  }
}));

export default router;
