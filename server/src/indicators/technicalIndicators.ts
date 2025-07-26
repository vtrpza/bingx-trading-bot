interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class TechnicalIndicators {
  /**
   * Calculate Simple Moving Average
   */
  static calculateSMA(data: number[], period: number): number[] {
    const result: number[] = [];
    
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        result.push(NaN);
        continue;
      }
      
      const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
    
    return result;
  }

  /**
   * Calculate Exponential Moving Average
   */
  static calculateEMA(data: number[], period: number): number[] {
    const result: number[] = [];
    const multiplier = 2 / (period + 1);
    
    // Start with SMA for the first period
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(...new Array(period - 1).fill(NaN), ema);
    
    // Calculate EMA for remaining values
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
      result.push(ema);
    }
    
    return result;
  }

  /**
   * Calculate Relative Strength Index (RSI)
   */
  static calculateRSI(data: number[], period: number = 14): number[] {
    const result: number[] = [];
    const gains: number[] = [];
    const losses: number[] = [];
    
    // Calculate price changes
    for (let i = 1; i < data.length; i++) {
      const change = data[i] - data[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? Math.abs(change) : 0);
    }
    
    // Not enough data
    if (gains.length < period) {
      return new Array(data.length).fill(NaN);
    }
    
    // Calculate initial average gain/loss
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    // First RSI value
    result.push(...new Array(period).fill(NaN));
    const rs = avgGain / (avgLoss || 0.00001); // Avoid division by zero
    result.push(100 - (100 / (1 + rs)));
    
    // Calculate remaining RSI values using smoothed averages
    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      
      const rs = avgGain / (avgLoss || 0.00001);
      result.push(100 - (100 / (1 + rs)));
    }
    
    return result;
  }

  /**
   * Detect crossovers between two lines
   */
  static detectCrossover(line1: number[], line2: number[]): { bullish: number[], bearish: number[] } {
    const bullish: number[] = [];
    const bearish: number[] = [];
    
    for (let i = 1; i < Math.min(line1.length, line2.length); i++) {
      if (isNaN(line1[i]) || isNaN(line2[i]) || isNaN(line1[i-1]) || isNaN(line2[i-1])) {
        continue;
      }
      
      // Bullish crossover: line1 crosses above line2
      if (line1[i-1] <= line2[i-1] && line1[i] > line2[i]) {
        bullish.push(i);
      }
      
      // Bearish crossover: line1 crosses below line2
      if (line1[i-1] >= line2[i-1] && line1[i] < line2[i]) {
        bearish.push(i);
      }
    }
    
    return { bullish, bearish };
  }

  /**
   * Calculate volume-based indicators
   */
  static analyzeVolume(candles: Candle[], lookbackPeriod: number = 20, spikeThreshold: number = 2): {
    avgVolume: number[];
    volumeSpikes: number[];
    volumeTrend: 'increasing' | 'decreasing' | 'stable';
  } {
    const volumes = candles.map(c => c.volume);
    const avgVolume = this.calculateSMA(volumes, lookbackPeriod);
    const volumeSpikes: number[] = [];
    
    // Detect volume spikes
    for (let i = lookbackPeriod - 1; i < volumes.length; i++) {
      if (volumes[i] > avgVolume[i] * spikeThreshold) {
        volumeSpikes.push(i);
      }
    }
    
    // Determine volume trend
    const recentAvg = avgVolume.slice(-5).filter(v => !isNaN(v));
    const olderAvg = avgVolume.slice(-10, -5).filter(v => !isNaN(v));
    
    let volumeTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
    if (recentAvg.length > 0 && olderAvg.length > 0) {
      const recentMean = recentAvg.reduce((a, b) => a + b, 0) / recentAvg.length;
      const olderMean = olderAvg.reduce((a, b) => a + b, 0) / olderAvg.length;
      
      if (recentMean > olderMean * 1.1) {
        volumeTrend = 'increasing';
      } else if (recentMean < olderMean * 0.9) {
        volumeTrend = 'decreasing';
      }
    }
    
    return { avgVolume, volumeSpikes, volumeTrend };
  }

  /**
   * Validate candle data integrity
   */
  static validateCandles(candles: Candle[]): {
    isValid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];
    
    // Check minimum data requirement
    if (candles.length < 50) {
      issues.push('Insufficient data: minimum 50 candles required');
    }
    
    // Check for data gaps
    for (let i = 1; i < candles.length; i++) {
      const timeDiff = candles[i].timestamp - candles[i-1].timestamp;
      const expectedDiff = candles[1].timestamp - candles[0].timestamp;
      
      if (timeDiff > expectedDiff * 1.5) {
        issues.push(`Data gap detected at index ${i}`);
      }
    }
    
    // Check for invalid values
    candles.forEach((candle, index) => {
      if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
        issues.push(`Invalid price data at index ${index}`);
      }
      
      if (candle.high < candle.low) {
        issues.push(`High < Low at index ${index}`);
      }
      
      if (candle.high < Math.max(candle.open, candle.close) || 
          candle.low > Math.min(candle.open, candle.close)) {
        issues.push(`Invalid OHLC relationship at index ${index}`);
      }
      
      if (candle.volume < 0) {
        issues.push(`Negative volume at index ${index}`);
      }
    });
    
    return {
      isValid: issues.length === 0,
      issues
    };
  }

  /**
   * Calculate all indicators for a set of candles
   */
  static calculateAllIndicators(candles: Candle[], config: {
    maPeriod1?: number;
    maPeriod2?: number;
    rsiPeriod?: number;
    volumePeriod?: number;
  } = {}) {
    const { 
      maPeriod1 = 9, 
      maPeriod2 = 21, 
      rsiPeriod = 14,
      volumePeriod = 20 
    } = config;
    
    const closes = candles.map(c => c.close);
    
    // Calculate indicators
    const ma1 = this.calculateEMA(closes, maPeriod1);
    const ma2 = this.calculateEMA(closes, maPeriod2);
    const rsi = this.calculateRSI(closes, rsiPeriod);
    const crossovers = this.detectCrossover(ma1, ma2);
    const volumeAnalysis = this.analyzeVolume(candles, volumePeriod);
    const validation = this.validateCandles(candles);
    
    return {
      ma1,
      ma2,
      rsi,
      crossovers,
      volumeAnalysis,
      validation,
      latestValues: {
        price: closes[closes.length - 1],
        ma1: ma1[ma1.length - 1],
        ma2: ma2[ma2.length - 1],
        rsi: rsi[rsi.length - 1],
        volume: candles[candles.length - 1].volume,
        avgVolume: volumeAnalysis.avgVolume[volumeAnalysis.avgVolume.length - 1]
      }
    };
  }
}