import { TechnicalIndicators } from '../indicators/technicalIndicators';
import { logger } from '../utils/logger';

export interface TradingSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  strength: number; // 0-100
  reason: string;
  indicators: {
    price: number;
    ma1: number;
    ma2: number;
    rsi: number;
    volume: number;
    avgVolume: number;
  };
  conditions: {
    maCrossover: boolean;
    rsiSignal: boolean;
    volumeConfirmation: boolean;
    trendAlignment: boolean;
  };
  timestamp: Date;
}

export interface SignalConfig {
  rsiOversold: number;
  rsiOverbought: number;
  volumeSpikeThreshold: number;
  minSignalStrength: number;
  confirmationRequired: boolean;
}

export class SignalGenerator {
  private config: SignalConfig;
  private indicatorCache: Map<string, any> = new Map();
  private static readonly CACHE_TTL = 60000; // 60s cache for indicators
  private lastProcessingTime: Map<string, number> = new Map();

  constructor(config?: Partial<SignalConfig>) {
    this.config = {
      rsiOversold: 30,
      rsiOverbought: 70,
      volumeSpikeThreshold: 1.5,
      minSignalStrength: 60,
      confirmationRequired: true,
      ...config
    };
    
    // Auto-cleanup cache every 2 minutes
    setInterval(() => this.cleanupCache(), 120000);
  }

  generateSignal(
    symbol: string,
    candles: any[],
    indicatorConfig?: any
  ): TradingSignal {
    const startTime = Date.now();
    
    try {
      // Fast validation with early returns
      const validationResult = this.fastValidateInput(symbol, candles);
      if (validationResult) return validationResult;

      // Check for cached indicators (performance boost)
      const cacheKey = this.generateCacheKey(symbol, candles);
      let indicators = this.getFromCache(cacheKey);
      
      if (!indicators) {
        // Calculate and cache indicators
        indicators = TechnicalIndicators.calculateAllIndicators(candles, indicatorConfig);
        this.setCache(cacheKey, indicators);
      }
      
      // Optimized validation with fallbacks
      const validatedIndicators = this.validateAndFixIndicators(symbol, indicators);
      if (!validatedIndicators) {
        return this.createHoldSignal(symbol, null, 'Invalid technical data');
      }

      // Fast conditions analysis
      const latestIndex = candles.length - 1;
      const conditions = this.analyzeConditions(validatedIndicators, latestIndex);
      
      // Generate optimized signal
      const signal = this.determineSignal(symbol, validatedIndicators.latestValues, conditions);
      
      // Track performance
      const processingTime = Date.now() - startTime;
      this.lastProcessingTime.set(symbol, processingTime);
      
      if (processingTime > 100) {
        logger.debug(`Slow signal generation for ${symbol}: ${processingTime}ms`);
      }
      
      return signal;
    } catch (error) {
      logger.error(`Error generating signal for ${symbol}:`, {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined
      });
      return this.createHoldSignal(symbol, null, `Signal generation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private analyzeConditions(indicators: any, latestIndex: number) {
    const conditions = {
      maCrossover: false,
      rsiSignal: false,
      volumeConfirmation: false,
      trendAlignment: false,
      crossoverType: null as 'bullish' | 'bearish' | null
    };

    // Check MA crossover - handle missing crossover data gracefully
    let recentBullishCrossover = false;
    let recentBearishCrossover = false;
    
    if (indicators.crossovers && indicators.crossovers.bullish && indicators.crossovers.bearish) {
      recentBullishCrossover = indicators.crossovers.bullish.some(
        (index: number) => index >= latestIndex - 3
      );
      recentBearishCrossover = indicators.crossovers.bearish.some(
        (index: number) => index >= latestIndex - 3
      );
    }

    if (recentBullishCrossover) {
      conditions.maCrossover = true;
      conditions.crossoverType = 'bullish';
    } else if (recentBearishCrossover) {
      conditions.maCrossover = true;
      conditions.crossoverType = 'bearish';
    }

    // Check RSI conditions
    const rsi = indicators.latestValues.rsi;
    if (rsi <= this.config.rsiOversold) {
      conditions.rsiSignal = true; // Oversold - potential buy
    } else if (rsi >= this.config.rsiOverbought) {
      conditions.rsiSignal = true; // Overbought - potential sell
    }

    // Check volume confirmation - handle missing volume data gracefully
    let volumeRatio = 1; // Default to neutral ratio
    if (indicators.latestValues.volume && indicators.latestValues.avgVolume && 
        indicators.latestValues.volume > 0 && indicators.latestValues.avgVolume > 0) {
      volumeRatio = indicators.latestValues.volume / indicators.latestValues.avgVolume;
    }
    conditions.volumeConfirmation = volumeRatio >= this.config.volumeSpikeThreshold;

    // Check trend alignment - handle missing MA data gracefully
    const ma1 = indicators.latestValues.ma1;
    const ma2 = indicators.latestValues.ma2;
    const price = indicators.latestValues.price;
    
    // Only check trend alignment if we have valid MA data
    if (ma1 && ma2 && price && !isNaN(ma1) && !isNaN(ma2) && !isNaN(price)) {
      // Bullish trend: price > MA1 > MA2
      // Bearish trend: price < MA1 < MA2
      if (price > ma1 && ma1 > ma2) {
        conditions.trendAlignment = true;
      } else if (price < ma1 && ma1 < ma2) {
        conditions.trendAlignment = true;
      }
    }

    return conditions;
  }

  private determineSignal(
    symbol: string,
    latestValues: any,
    conditions: any
  ): TradingSignal {
    let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    let strength = 0;
    let reasons: string[] = [];


    // Buy conditions
    const buyConditions = {
      oversold: latestValues.rsi <= this.config.rsiOversold,
      bullishCrossover: conditions.maCrossover && conditions.crossoverType === 'bullish',
      bullishTrend: latestValues.price > latestValues.ma1 && latestValues.ma1 > latestValues.ma2,
      volumeSpike: conditions.volumeConfirmation
    };

    // Sell conditions
    const sellConditions = {
      overbought: latestValues.rsi >= this.config.rsiOverbought,
      bearishCrossover: conditions.maCrossover && conditions.crossoverType === 'bearish',
      bearishTrend: latestValues.price < latestValues.ma1 && latestValues.ma1 < latestValues.ma2,
      volumeSpike: conditions.volumeConfirmation
    };


    // Calculate buy signal strength
    let buyStrength = 0;
    if (buyConditions.oversold) {
      buyStrength += 30;
      reasons.push('RSI oversold');
    }
    if (buyConditions.bullishCrossover) {
      buyStrength += 35;
      reasons.push('Bullish MA crossover');
    }
    if (buyConditions.bullishTrend) {
      buyStrength += 25;
      reasons.push('Bullish trend alignment');
    }
    if (buyConditions.volumeSpike && (buyConditions.oversold || buyConditions.bullishCrossover)) {
      buyStrength += 10;
      reasons.push('Volume confirmation');
    }

    // Calculate sell signal strength
    let sellStrength = 0;
    if (sellConditions.overbought) {
      sellStrength += 30;
      reasons.push('RSI overbought');
    }
    if (sellConditions.bearishCrossover) {
      sellStrength += 35;
      reasons.push('Bearish MA crossover');
    }
    if (sellConditions.bearishTrend) {
      sellStrength += 25;
      reasons.push('Bearish trend alignment');
    }
    if (sellConditions.volumeSpike && (sellConditions.overbought || sellConditions.bearishCrossover)) {
      sellStrength += 10;
      reasons.push('Volume confirmation');
    }

    // Determine action
    if (buyStrength >= this.config.minSignalStrength && buyStrength > sellStrength) {
      action = 'BUY';
      strength = buyStrength;
    } else if (sellStrength >= this.config.minSignalStrength && sellStrength > buyStrength) {
      action = 'SELL';
      strength = sellStrength;
    } else {
      // Still show the highest strength even for HOLD signals
      strength = Math.max(buyStrength, sellStrength);
      if (strength === 0) {
        reasons = ['No clear signal'];
      } else if (buyStrength > sellStrength) {
        reasons.unshift(`Buy signal too weak (${buyStrength}% < ${this.config.minSignalStrength}% required)`);
      } else if (sellStrength > buyStrength) {
        reasons.unshift(`Sell signal too weak (${sellStrength}% < ${this.config.minSignalStrength}% required)`);
      } else {
        reasons.unshift(`Equal buy/sell signals (${strength}%)`);
      }
    }

    // Additional confirmation check
    if (this.config.confirmationRequired && action !== 'HOLD') {
      const confirmations = [
        conditions.maCrossover,
        conditions.rsiSignal,
        conditions.trendAlignment
      ].filter(Boolean).length;

      if (confirmations < 2) {
        action = 'HOLD';
        strength = Math.max(buyStrength, sellStrength);
        reasons.push('Insufficient confirmations');
      }
    }

    return {
      symbol,
      action,
      strength,
      reason: reasons.join(', '),
      indicators: latestValues,
      conditions: {
        maCrossover: conditions.maCrossover,
        rsiSignal: conditions.rsiSignal,
        volumeConfirmation: conditions.volumeConfirmation,
        trendAlignment: conditions.trendAlignment
      },
      timestamp: new Date()
    };
  }

  private createHoldSignal(
    symbol: string,
    indicators: any,
    reason: string
  ): TradingSignal {
    // Ensure indicators is always a valid object with required properties
    // Provide meaningful values when possible, use null for unavailable data
    const safeIndicators = {
      price: (indicators?.price && !isNaN(indicators.price)) ? indicators.price : 0,
      ma1: (indicators?.ma1 && !isNaN(indicators.ma1)) ? indicators.ma1 : (indicators?.price || 0),
      ma2: (indicators?.ma2 && !isNaN(indicators.ma2)) ? indicators.ma2 : (indicators?.price || 0),
      rsi: (indicators?.rsi && !isNaN(indicators.rsi)) ? indicators.rsi : 50, // Default to neutral RSI
      volume: (indicators?.volume && !isNaN(indicators.volume)) ? indicators.volume : 0,
      avgVolume: (indicators?.avgVolume && !isNaN(indicators.avgVolume)) ? indicators.avgVolume : (indicators?.volume || 0)
    };

    return {
      symbol,
      action: 'HOLD',
      strength: 0,
      reason: reason || 'No trading signal detected',
      indicators: safeIndicators,
      conditions: {
        maCrossover: false,
        rsiSignal: false,
        volumeConfirmation: false,
        trendAlignment: false
      },
      timestamp: new Date()
    };
  }

  // ⚡ PERFORMANCE OPTIMIZATION METHODS
  
  private fastValidateInput(symbol: string, candles: any[]): TradingSignal | null {
    if (!candles?.length) {
      return this.createHoldSignal(symbol, null, 'No market data');
    }
    if (candles.length < 50) {
      return this.createHoldSignal(symbol, null, 'Insufficient data');
    }
    return null;
  }
  
  private generateCacheKey(symbol: string, candles: any[]): string {
    const latestCandle = candles[candles.length - 1];
    return `${symbol}_${latestCandle.timestamp}_${candles.length}`;
  }
  
  private getFromCache(key: string): any {
    const cached = this.indicatorCache.get(key);
    if (cached && Date.now() - cached.timestamp < SignalGenerator.CACHE_TTL) {
      return cached.data;
    }
    return null;
  }
  
  private setCache(key: string, data: any): void {
    this.indicatorCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }
  
  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, cached] of this.indicatorCache.entries()) {
      if (now - cached.timestamp > SignalGenerator.CACHE_TTL) {
        this.indicatorCache.delete(key);
      }
    }
  }
  
  private validateAndFixIndicators(symbol: string, indicators: any): any {
    if (!indicators?.latestValues) return null;
    
    const values = indicators.latestValues;
    
    // Quick validation with fallbacks
    if (!values.price || isNaN(values.price)) return null;
    
    // Auto-fix missing indicators
    if (!values.ma1 || isNaN(values.ma1)) values.ma1 = values.price;
    if (!values.ma2 || isNaN(values.ma2)) values.ma2 = values.price;
    if (!values.rsi || isNaN(values.rsi)) values.rsi = 50;
    
    return indicators;
  }
  
  // Performance monitoring
  getPerformanceMetrics(): { avgProcessingTime: number; cacheSize: number; cacheHitRate: number } {
    const times = Array.from(this.lastProcessingTime.values());
    return {
      avgProcessingTime: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
      cacheSize: this.indicatorCache.size,
      cacheHitRate: 0 // TODO: implement hit rate tracking
    };
  }

  updateConfig(config: Partial<SignalConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): SignalConfig {
    return { ...this.config };
  }
}