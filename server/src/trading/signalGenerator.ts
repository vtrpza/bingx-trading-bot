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

  constructor(config?: Partial<SignalConfig>) {
    this.config = {
      rsiOversold: 30,
      rsiOverbought: 70,
      volumeSpikeThreshold: 1.5,
      minSignalStrength: 60,
      confirmationRequired: true,
      ...config
    };
  }

  generateSignal(
    symbol: string,
    candles: any[],
    indicatorConfig?: any
  ): TradingSignal {
    try {
      // Validate input
      if (!candles || candles.length === 0) {
        logger.warn(`No candles data provided for ${symbol}`);
        return this.createHoldSignal(symbol, null, 'No market data available');
      }

      if (candles.length < 50) {
        logger.warn(`Insufficient candles data for ${symbol}: ${candles.length} candles`);
        return this.createHoldSignal(symbol, null, 'Insufficient historical data');
      }

      // Calculate all indicators
      const indicators = TechnicalIndicators.calculateAllIndicators(candles, indicatorConfig);
      
      // Validate data
      if (!indicators || !indicators.validation) {
        logger.error(`Failed to calculate indicators for ${symbol}`);
        return this.createHoldSignal(symbol, null, 'Technical indicators calculation failed');
      }

      if (!indicators.validation.isValid) {
        logger.warn(`Invalid candle data for ${symbol}:`, indicators.validation.issues);
        return this.createHoldSignal(symbol, indicators.latestValues, 'Invalid market data detected');
      }

      // Validate latest values exist and are valid numbers
      if (!indicators.latestValues) {
        logger.error(`No latest values calculated for ${symbol}`);
        return this.createHoldSignal(symbol, null, 'No current market data');
      }

      // Check for sufficient data
      const latestIndex = candles.length - 1;
      
      // Validate technical indicators - be more lenient
      if (!indicators.latestValues) {
        logger.warn(`No latest values for ${symbol}`);
        return this.createHoldSignal(symbol, null, 'No technical indicators available');
      }

      // Check if we have sufficient data to generate a meaningful signal
      const hasValidPrice = indicators.latestValues.price && !isNaN(indicators.latestValues.price);
      const hasValidMA1 = indicators.latestValues.ma1 && !isNaN(indicators.latestValues.ma1);
      const hasValidMA2 = indicators.latestValues.ma2 && !isNaN(indicators.latestValues.ma2);
      const hasValidRSI = indicators.latestValues.rsi && !isNaN(indicators.latestValues.rsi);

      if (!hasValidPrice) {
        logger.warn(`No valid price data for ${symbol}`);
        return this.createHoldSignal(symbol, indicators.latestValues, 'No current price data available');
      }

      // If some indicators are missing, still try to generate signal with available data
      if (!hasValidMA1 || !hasValidMA2 || !hasValidRSI) {
        logger.debug(`Some technical indicators missing for ${symbol}:`, {
          hasMA1: hasValidMA1,
          hasMA2: hasValidMA2,
          hasRSI: hasValidRSI,
          ma1: indicators.latestValues.ma1,
          ma2: indicators.latestValues.ma2,
          rsi: indicators.latestValues.rsi,
          price: indicators.latestValues.price
        });
        
        // Use fallback values for missing indicators to ensure we can still generate signals
        if (!hasValidMA1 && hasValidPrice) {
          indicators.latestValues.ma1 = indicators.latestValues.price;
        }
        if (!hasValidMA2 && hasValidPrice) {
          indicators.latestValues.ma2 = indicators.latestValues.price;
        }
        if (!hasValidRSI) {
          indicators.latestValues.rsi = 50; // Neutral RSI
        }
      }

      // Analyze conditions
      const conditions = this.analyzeConditions(indicators, latestIndex);
      
      // Generate signal based on conditions
      const signal = this.determineSignal(symbol, indicators.latestValues, conditions);
      
      logger.debug(`Signal generated for ${symbol}:`, {
        action: signal.action,
        strength: signal.strength,
        reason: signal.reason
      });
      
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
    // Use null/undefined to show N/A in frontend instead of misleading zeros
    const safeIndicators = {
      price: (indicators?.price && !isNaN(indicators.price)) ? indicators.price : null,
      ma1: (indicators?.ma1 && !isNaN(indicators.ma1)) ? indicators.ma1 : null,
      ma2: (indicators?.ma2 && !isNaN(indicators.ma2)) ? indicators.ma2 : null,
      rsi: (indicators?.rsi && !isNaN(indicators.rsi)) ? indicators.rsi : 50, // Default to neutral RSI
      volume: (indicators?.volume && !isNaN(indicators.volume)) ? indicators.volume : null,
      avgVolume: (indicators?.avgVolume && !isNaN(indicators.avgVolume)) ? indicators.avgVolume : null
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

  updateConfig(config: Partial<SignalConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): SignalConfig {
    return { ...this.config };
  }
}