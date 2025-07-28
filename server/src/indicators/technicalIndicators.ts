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
   * ⚡ Optimized Simple Moving Average with rolling sum
   */
  static calculateSMA(data: number[], period: number): number[] {
    const result: number[] = new Array(data.length);
    
    if (data.length < period) {
      return result.fill(NaN);
    }
    
    // Fill initial NaN values
    for (let i = 0; i < period - 1; i++) {
      result[i] = NaN;
    }
    
    // Calculate first SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += data[i];
    }
    result[period - 1] = sum / period;
    
    // Rolling calculation (much faster)
    for (let i = period; i < data.length; i++) {
      sum = sum - data[i - period] + data[i];
      result[i] = sum / period;
    }
    
    return result;
  }

  /**
   * Calculate Exponential Moving Average
   */
  static calculateEMA(data: number[], period: number): number[] {
    const result: number[] = [];
    const multiplier = 2 / (period + 1);
    
    // Validate input
    if (data.length < period) {
      return new Array(data.length).fill(NaN);
    }
    
    // Validate first period data contains no NaN values
    const firstPeriodData = data.slice(0, period);
    if (firstPeriodData.some(val => isNaN(val) || !isFinite(val))) {
      return new Array(data.length).fill(NaN);
    }
    
    // Start with SMA for the first period
    let ema = firstPeriodData.reduce((a, b) => a + b, 0) / period;
    result.push(...new Array(period - 1).fill(NaN), ema);
    
    // Calculate EMA for remaining values
    for (let i = period; i < data.length; i++) {
      if (isNaN(data[i]) || !isFinite(data[i])) {
        result.push(NaN);
        continue;
      }
      ema = (data[i] - ema) * multiplier + ema;
      result.push(ema);
    }
    
    return result;
  }

  /**
   * ⚡ Optimized RSI with Wilder's smoothing
   */
  static calculateRSI(data: number[], period: number = 14): number[] {
    const result: number[] = new Array(data.length);
    
    if (data.length <= period) {
      return result.fill(NaN);
    }
    
    // Pre-fill NaN values
    for (let i = 0; i <= period; i++) {
      result[i] = NaN;
    }
    
    // Calculate initial gains/losses
    let sumGain = 0;
    let sumLoss = 0;
    
    for (let i = 1; i <= period; i++) {
      const change = data[i] - data[i - 1];
      if (change > 0) {
        sumGain += change;
      } else {
        sumLoss += Math.abs(change);
      }
    }
    
    // Calculate first RSI
    let avgGain = sumGain / period;
    let avgLoss = sumLoss / period;
    
    const alpha = 1 / period; // Wilder's smoothing factor
    
    for (let i = period + 1; i < data.length; i++) {
      const change = data[i] - data[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      
      // Wilder's smoothing (faster than traditional calculation)
      avgGain = alpha * gain + (1 - alpha) * avgGain;
      avgLoss = alpha * loss + (1 - alpha) * avgLoss;
      
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result[i] = 100 - (100 / (1 + rs));
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
   * ⚡ High-Performance Batch Indicator Calculation
   */
  static calculateAllIndicators(candles: Candle[], config: {
    maPeriod1?: number;
    maPeriod2?: number;
    rsiPeriod?: number;
    volumePeriod?: number;
  } = {}) {
    const startTime = Date.now();
    
    const { 
      maPeriod1 = 9, 
      maPeriod2 = 21, 
      rsiPeriod = 14,
      volumePeriod = 20 
    } = config;
    
    // Extract arrays once for better performance
    const closes = new Float64Array(candles.length);
    const volumes = new Float64Array(candles.length);
    
    for (let i = 0; i < candles.length; i++) {
      closes[i] = candles[i].close;
      volumes[i] = candles[i].volume;
    }
    
    // Fast validation
    if (closes.length < Math.max(maPeriod1, maPeriod2, rsiPeriod, volumePeriod)) {
      return {
        validation: { isValid: false, issues: ['Insufficient data'] },
        latestValues: {
          price: closes[closes.length - 1] || 0,
          ma1: 0, ma2: 0, rsi: 50,
          volume: volumes[volumes.length - 1] || 0,
          avgVolume: 0
        }
      };
    }
    
    // Calculate all indicators in parallel
    const [ma1, ma2, rsi] = [
      this.calculateEMA(Array.from(closes), maPeriod1),
      this.calculateEMA(Array.from(closes), maPeriod2),
      this.calculateRSI(Array.from(closes), rsiPeriod)
    ];
    
    // Fast crossover detection (only check recent periods)
    const crossovers = this.detectCrossover(ma1.slice(-20), ma2.slice(-20));
    
    // Simplified volume analysis
    const avgVolume = this.calculateSMA(Array.from(volumes), volumePeriod);
    const volumeAnalysis = {
      avgVolume,
      volumeSpikes: [],
      volumeTrend: 'stable' as const
    };
    
    // Fast value extraction
    const getLastValid = (arr: number[], fallback: number = 0): number => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const val = arr[i];
        if (!isNaN(val) && isFinite(val)) return val;
      }
      return fallback;
    };
    
    const processingTime = Date.now() - startTime;
    
    return {
      ma1, ma2, rsi, crossovers, volumeAnalysis,
      validation: { isValid: true, issues: [] },
      processingTime,
      latestValues: {
        price: closes[closes.length - 1],
        ma1: getLastValid(ma1),
        ma2: getLastValid(ma2),
        rsi: getLastValid(rsi, 50),
        volume: volumes[volumes.length - 1],
        avgVolume: getLastValid(avgVolume)
      }
    };
  }
}