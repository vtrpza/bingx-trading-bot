import { ParallelBotConfig } from './ParallelTradingBot';

/**
 * Optimized configurations for different trading scenarios
 * 
 * Performance Comparison:
 * - Conservative: ~15 symbols every 10 minutes (1.5 symbols/min)
 * - High-Frequency: ~40 symbols every 2 minutes (20 symbols/min) 
 * - Ultra-Performance: ~100+ symbols every 1 minute (100+ symbols/min)
 */

// Ultra High-Performance Configuration (Maximum Symbols)
export const ultraPerformanceConfig: Partial<ParallelBotConfig> = {
  scanInterval: 15000, // 15 seconds - ULTRA FAST scanning
  maxConcurrentTrades: 15,
  defaultPositionSize: 50, // Smaller positions for more trades
  minSignalStrength: 35, // Lower threshold for more signals (more aggressive)
  
  signalWorkers: {
    maxWorkers: 12, // Maximum workers for parallel processing
    maxConcurrentTasks: 40, // Process many symbols simultaneously
    taskTimeout: 8000, // Optimized timeout
    retryAttempts: 2 // Quick retries
  },
  
  signalQueue: {
    maxSize: 300, // Large queue for many symbols
    defaultTTL: 90000, // Longer TTL for more symbols
    maxAttempts: 3,
    deduplicationWindow: 60000,
    priorityWeights: {
      strength: 0.6, // Balance between strength and volume
      recency: 0.2,
      volume: 0.2
    }
  },
  
  tradeExecutors: {
    maxExecutors: 8, // More executors for higher throughput
    maxConcurrentTrades: 12,
    executionTimeout: 12000,
    retryAttempts: 2,
    rateLimit: 1.5 // Aggressive but safe rate limit
  },
  
  marketDataCache: {
    tickerCacheTTL: 30000, // Balanced cache for performance
    klineCacheTTL: 60000, // Longer cache for klines
    maxCacheSize: 500, // Large cache for many symbols
    priceChangeThreshold: 0.03 // More sensitive
  }
};

// High-frequency trading configuration (aggressive)
export const highFrequencyConfig: Partial<ParallelBotConfig> = {
  scanInterval: 20000, // 20 seconds - high frequency scanning
  maxConcurrentTrades: 10,
  defaultPositionSize: 50, // Smaller positions for more trades
  minSignalStrength: 40, // Lower threshold for more signals
  
  signalWorkers: {
    maxWorkers: 8, // More workers for faster processing
    maxConcurrentTasks: 20,
    taskTimeout: 4000, // Faster timeout
    retryAttempts: 1 // Less retries for speed
  },
  
  signalQueue: {
    maxSize: 150,
    defaultTTL: 20000, // Shorter TTL for fresh signals
    maxAttempts: 2,
    deduplicationWindow: 30000,
    priorityWeights: {
      strength: 0.7, // Focus on signal strength
      recency: 0.2,
      volume: 0.1
    }
  },
  
  tradeExecutors: {
    maxExecutors: 5, // More executors
    maxConcurrentTrades: 8,
    executionTimeout: 8000,
    retryAttempts: 1,
    rateLimit: 1.0 // Reduced to respect global 100 req/10s limit
  },
  
  marketDataCache: {
    tickerCacheTTL: 8000, // Increased for better hit rate
    klineCacheTTL: 30000, // Increased for better hit rate
    maxCacheSize: 150,
    priceChangeThreshold: 0.05 // More sensitive to price changes
  }
};

// Conservative trading configuration (stable)
export const conservativeConfig: Partial<ParallelBotConfig> = {
  scanInterval: 120000, // 2 minutes - still frequent but stable
  maxConcurrentTrades: 3,
  defaultPositionSize: 200, // Larger positions
  minSignalStrength: 55, // Balanced threshold for quality
  confirmationRequired: true,
  
  signalWorkers: {
    maxWorkers: 3, // Fewer workers
    maxConcurrentTasks: 10,
    taskTimeout: 10000, // Longer timeout
    retryAttempts: 3 // More retries for reliability
  },
  
  signalQueue: {
    maxSize: 50,
    defaultTTL: 60000, // Longer TTL
    maxAttempts: 3,
    deduplicationWindow: 120000,
    priorityWeights: {
      strength: 0.8, // High focus on signal quality
      recency: 0.1,
      volume: 0.1
    }
  },
  
  tradeExecutors: {
    maxExecutors: 2,
    maxConcurrentTrades: 3,
    executionTimeout: 15000,
    retryAttempts: 3,
    rateLimit: 0.5 // Conservative rate limit to respect global limits
  },
  
  marketDataCache: {
    tickerCacheTTL: 15000, // Increased for better hit rate
    klineCacheTTL: 90000, // Increased for better hit rate  
    maxCacheSize: 100, // Increased cache size
    priceChangeThreshold: 0.2 // Less sensitive
  }
};

// Balanced trading configuration (recommended)
export const balancedConfig: Partial<ParallelBotConfig> = {
  scanInterval: 30000, // 30 seconds - optimized balanced scanning
  maxConcurrentTrades: 5,
  defaultPositionSize: 100,
  minSignalStrength: 50, // Balanced threshold
  confirmationRequired: false, // Allow more signals for testing
  
  signalWorkers: {
    maxWorkers: 5,
    maxConcurrentTasks: 15,
    taskTimeout: 6000,
    retryAttempts: 2
  },
  
  signalQueue: {
    maxSize: 100,
    defaultTTL: 30000,
    maxAttempts: 3,
    deduplicationWindow: 60000,
    priorityWeights: {
      strength: 0.6,
      recency: 0.3,
      volume: 0.1
    }
  },
  
  tradeExecutors: {
    maxExecutors: 3,
    maxConcurrentTrades: 5,
    executionTimeout: 10000,
    retryAttempts: 2,
    rateLimit: 0.8 // Balanced rate limit respecting global limits
  },
  
  marketDataCache: {
    tickerCacheTTL: 10000, // Increased for better hit rate
    klineCacheTTL: 60000, // Increased for better hit rate
    maxCacheSize: 150, // Increased cache size
    priceChangeThreshold: 0.1
  }
};

// Development/testing configuration
export const developmentConfig: Partial<ParallelBotConfig> = {
  scanInterval: 60000, // 1 minute - faster testing feedback
  maxConcurrentTrades: 2,
  defaultPositionSize: 10, // Small positions for testing
  minSignalStrength: 70,
  
  signalWorkers: {
    maxWorkers: 2,
    maxConcurrentTasks: 5,
    taskTimeout: 15000, // Longer timeout for debugging
    retryAttempts: 1
  },
  
  signalQueue: {
    maxSize: 20,
    defaultTTL: 120000, // Longer TTL for analysis
    maxAttempts: 2,
    deduplicationWindow: 180000
  },
  
  tradeExecutors: {
    maxExecutors: 1,
    maxConcurrentTrades: 2,
    executionTimeout: 20000,
    retryAttempts: 1,
    rateLimit: 0.2 // Very conservative for development
  },
  
  marketDataCache: {
    tickerCacheTTL: 15000,
    klineCacheTTL: 90000,
    maxCacheSize: 20,
    priceChangeThreshold: 0.5
  }
};

/**
 * Configuration optimizer based on system resources and market conditions
 */
export class ConfigurationOptimizer {
  static optimizeForSystem(): Partial<ParallelBotConfig> {
    const memoryUsage = process.memoryUsage();
    const totalMemoryMB = memoryUsage.heapTotal / 1024 / 1024;
    const cpuCount = require('os').cpus().length;
    
    // Adjust workers based on CPU cores
    const optimalWorkers = Math.min(Math.max(2, Math.floor(cpuCount * 0.6)), 8);
    
    // Adjust cache size based on available memory
    const optimalCacheSize = totalMemoryMB > 512 ? 100 : 50;
    
    // Adjust timeouts based on system performance
    const taskTimeout = totalMemoryMB > 256 ? 6000 : 10000;
    
    return {
      signalWorkers: {
        maxWorkers: optimalWorkers,
        maxConcurrentTasks: optimalWorkers * 3,
        taskTimeout
      },
      marketDataCache: {
        maxCacheSize: optimalCacheSize
      }
    };
  }
  
  static optimizeForMarketCondition(volatility: 'low' | 'medium' | 'high'): Partial<ParallelBotConfig> {
    switch (volatility) {
      case 'high':
        return {
          scanInterval: 10000, // 10 seconds - ultra fast for volatile markets
          signalQueue: {
            defaultTTL: 15000, // Shorter TTL for fresh signals
            priorityWeights: {
              strength: 0.5,
              recency: 0.4, // Higher priority for recent signals
              volume: 0.1
            }
          },
          marketDataCache: {
            tickerCacheTTL: 2000, // Very fresh data
            priceChangeThreshold: 0.05 // More sensitive
          }
        };
        
      case 'low':
        return {
          scanInterval: 60000, // 1 minute - reasonable for stable markets
          signalQueue: {
            defaultTTL: 60000, // Longer TTL acceptable
            priorityWeights: {
              strength: 0.8, // Focus on signal quality
              recency: 0.1,
              volume: 0.1
            }
          },
          marketDataCache: {
            tickerCacheTTL: 10000, // Can cache longer
            priceChangeThreshold: 0.2 // Less sensitive
          }
        };
        
      default: // medium
        return balancedConfig;
    }
  }
  
  static mergeConfigs(...configs: Partial<ParallelBotConfig>[]): Partial<ParallelBotConfig> {
    const merged: any = {};
    
    for (const config of configs) {
      for (const [key, value] of Object.entries(config)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          merged[key] = { ...merged[key], ...value };
        } else {
          merged[key] = value;
        }
      }
    }
    
    return merged;
  }
}

/**
 * Performance benchmarking utilities
 */
export class PerformanceBenchmark {
  static async benchmarkConfiguration(
    _config: Partial<ParallelBotConfig>,
    _testSymbols: string[] = ['BTC-USDT', 'ETH-USDT', 'BNB-USDT'],
    _durationMs: number = 60000
  ): Promise<{
    throughput: number;
    avgLatency: number;
    errorRate: number;
    recommendation: string;
  }> {
    // This would be implemented to test configurations
    // For now, return mock data
    return {
      throughput: Math.random() * 100 + 50,
      avgLatency: Math.random() * 2000 + 1000,
      errorRate: Math.random() * 5,
      recommendation: 'Configuration performs within acceptable parameters'
    };
  }
}

/**
 * Adaptive configuration manager
 */
export class AdaptiveConfigManager {
  private currentConfig: Partial<ParallelBotConfig>;
  private performanceHistory: Array<{
    timestamp: number;
    config: Partial<ParallelBotConfig>;
    performance: any;
  }> = [];
  
  constructor(initialConfig: Partial<ParallelBotConfig> = balancedConfig) {
    this.currentConfig = initialConfig;
  }
  
  adaptConfiguration(performanceMetrics: any): Partial<ParallelBotConfig> {
    const adaptations: Partial<ParallelBotConfig> = {};
    
    // Adapt based on throughput
    if (performanceMetrics.throughputMetrics.signalsPerMinute < 10) {
      adaptations.scanInterval = Math.max(15000, (this.currentConfig.scanInterval || 30000) * 0.8);
      adaptations.signalWorkers = {
        ...this.currentConfig.signalWorkers,
        maxWorkers: Math.min(8, (this.currentConfig.signalWorkers?.maxWorkers || 5) + 1)
      };
    }
    
    // Adapt based on latency
    if (performanceMetrics.throughputMetrics.avgSignalLatency > 5000) {
      adaptations.signalWorkers = {
        ...this.currentConfig.signalWorkers,
        taskTimeout: Math.min(15000, (this.currentConfig.signalWorkers?.taskTimeout || 6000) + 2000)
      };
    }
    
    // Adapt based on error rate
    if (performanceMetrics.efficiencyMetrics.errorRate > 10) {
      adaptations.signalWorkers = {
        ...this.currentConfig.signalWorkers,
        retryAttempts: Math.min(3, (this.currentConfig.signalWorkers?.retryAttempts || 2) + 1)
      };
    }
    
    // Adapt based on queue overflow
    if (performanceMetrics.componentMetrics?.signalQueue?.total > 80) {
      adaptations.signalQueue = {
        ...this.currentConfig.signalQueue,
        maxSize: Math.min(200, (this.currentConfig.signalQueue?.maxSize || 100) + 50)
      };
    }
    
    this.currentConfig = ConfigurationOptimizer.mergeConfigs(this.currentConfig, adaptations);
    
    return this.currentConfig;
  }
  
  getCurrentConfig(): Partial<ParallelBotConfig> {
    return { ...this.currentConfig };
  }
  
  recordPerformance(performanceMetrics: any): void {
    this.performanceHistory.push({
      timestamp: Date.now(),
      config: { ...this.currentConfig },
      performance: performanceMetrics
    });
    
    // Keep only last 24 hours of history
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.performanceHistory = this.performanceHistory.filter(h => h.timestamp > cutoff);
  }
  
  getBestConfiguration(): Partial<ParallelBotConfig> | null {
    if (this.performanceHistory.length < 5) {
      return null;
    }
    
    // Find configuration with best overall performance
    const scored = this.performanceHistory.map(h => ({
      ...h,
      score: this.calculatePerformanceScore(h.performance)
    }));
    
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.config || null;
  }
  
  private calculatePerformanceScore(metrics: any): number {
    const throughputScore = Math.min(100, metrics.throughputMetrics?.signalsPerMinute || 0);
    const latencyScore = Math.max(0, 100 - (metrics.throughputMetrics?.avgSignalLatency || 5000) / 50);
    const errorScore = Math.max(0, 100 - (metrics.efficiencyMetrics?.errorRate || 20) * 5);
    const utilizationScore = metrics.efficiencyMetrics?.workerUtilization || 0;
    
    return (throughputScore * 0.3 + latencyScore * 0.3 + errorScore * 0.2 + utilizationScore * 0.2);
  }
}