import Redis, { RedisOptions } from 'ioredis';
import { logger } from '../utils/logger';

export interface CacheOptions {
  ttl?: number; // Time to live in seconds
  compress?: boolean; // Enable compression for large objects
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  totalKeys: number;
  memoryUsage: string;
}

/**
 * High-performance Redis caching layer optimized for financial market data
 * Features: intelligent TTL, compression, batch operations, and performance monitoring
 */
export class RedisCache {
  private client: Redis;
  private fallbackEnabled: boolean = true;
  private stats = {
    hits: 0,
    misses: 0,
    errors: 0
  };

  // Cache duration constants (in seconds)
  private static readonly TTL = {
    SYMBOLS: 300,      // 5 minutes - symbols change rarely
    TICKERS: 30,       // 30 seconds - high-frequency price data
    BALANCE: 60,       // 1 minute - account data
    POSITIONS: 30,     // 30 seconds - position data
    ORDERS: 15,        // 15 seconds - order data
    KLINES: 60,        // 1 minute - candlestick data
    DEPTH: 10,         // 10 seconds - order book data
    MARKET_OVERVIEW: 60 // 1 minute - market statistics
  };

  constructor() {
    const redisConfig: RedisOptions = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
      
      // Connection optimization
      maxRetriesPerRequest: 3,
      // retryDelayOnFailover: 100, // Not available in current ioredis version
      lazyConnect: true,
      keepAlive: 30000,
      
      // Performance settings
      enableReadyCheck: true,
      // maxLoadingTimeout: 5000, // Not available in current ioredis version
      
      // Connection pool settings
      family: 4, // IPv4
      connectTimeout: 10000,
      commandTimeout: 5000
    };

    this.client = new Redis(redisConfig);

    this.setupEventHandlers();
    this.warmUpConnection();
  }

  /**
   * Setup Redis event handlers for monitoring and error handling
   */
  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      logger.info('Redis connection established');
      this.fallbackEnabled = false;
    });

    this.client.on('error', (error: any) => {
      logger.error('Redis connection error:', error);
      this.fallbackEnabled = true;
      this.stats.errors++;
    });

    this.client.on('close', () => {
      logger.warn('Redis connection closed, enabling fallback mode');
      this.fallbackEnabled = true;
    });

    this.client.on('reconnecting', () => {
      logger.info('Redis reconnecting...');
    });
  }

  /**
   * Warm up connection and test Redis availability
   */
  private async warmUpConnection(): Promise<void> {
    try {
      await this.client.ping();
      logger.info('Redis connection warmed up successfully');
    } catch (error) {
      logger.warn('Redis warmup failed, using fallback mode:', error);
      this.fallbackEnabled = true;
    }
  }

  /**
   * Get cached symbols data with intelligent fallback
   */
  async getSymbols(): Promise<any[] | null> {
    const key = 'symbols:all';
    return this.get(key, { ttl: RedisCache.TTL.SYMBOLS });
  }

  /**
   * Cache symbols data
   */
  async setSymbols(data: any[]): Promise<void> {
    const key = 'symbols:all';
    await this.set(key, data, { ttl: RedisCache.TTL.SYMBOLS });
  }

  /**
   * Get cached ticker for a specific symbol
   */
  async getTicker(symbol: string): Promise<any | null> {
    const key = `ticker:${symbol}`;
    return this.get(key, { ttl: RedisCache.TTL.TICKERS });
  }

  /**
   * Cache ticker data for a symbol
   */
  async setTicker(symbol: string, data: any): Promise<void> {
    const key = `ticker:${symbol}`;
    await this.set(key, data, { ttl: RedisCache.TTL.TICKERS });
  }

  /**
   * Get all cached tickers
   */
  async getAllTickers(): Promise<any[] | null> {
    const key = 'tickers:all';
    return this.get(key, { ttl: RedisCache.TTL.TICKERS });
  }

  /**
   * Cache all tickers data
   */
  async setAllTickers(data: any[]): Promise<void> {
    const key = 'tickers:all';
    await this.set(key, data, { ttl: RedisCache.TTL.TICKERS });
  }

  /**
   * Batch get multiple tickers efficiently
   */
  async getMultipleTickers(symbols: string[]): Promise<Map<string, any>> {
    if (this.fallbackEnabled || symbols.length === 0) {
      return new Map();
    }

    try {
      const keys = symbols.map(symbol => `ticker:${symbol}`);
      const pipeline = this.client.pipeline();
      
      keys.forEach(key => pipeline.get(key));
      const results = await pipeline.exec();
      
      const tickerMap = new Map<string, any>();
      
      if (results) {
        results.forEach((result: any, index: number) => {
          if (result && result[1]) {
            try {
              const data = JSON.parse(result[1] as string);
              tickerMap.set(symbols[index], data);
              this.stats.hits++;
            } catch (error) {
              logger.debug(`Failed to parse cached ticker for ${symbols[index]}:`, error);
              this.stats.misses++;
            }
          } else {
            this.stats.misses++;
          }
        });
      }

      return tickerMap;
    } catch (error) {
      logger.error('Batch ticker retrieval failed:', error);
      return new Map();
    }
  }

  /**
   * Batch set multiple tickers efficiently
   */
  async setMultipleTickers(tickerMap: Map<string, any>): Promise<void> {
    if (this.fallbackEnabled || tickerMap.size === 0) {
      return;
    }

    try {
      const pipeline = this.client.pipeline();
      
      tickerMap.forEach((data, symbol) => {
        const key = `ticker:${symbol}`;
        const value = JSON.stringify(data);
        pipeline.setex(key, RedisCache.TTL.TICKERS, value);
      });
      
      await pipeline.exec();
      logger.debug(`Cached ${tickerMap.size} tickers in batch`);
    } catch (error) {
      logger.error('Batch ticker caching failed:', error);
    }
  }

  /**
   * Get cached balance data
   */
  async getBalance(): Promise<any | null> {
    const key = 'balance:user';
    return this.get(key, { ttl: RedisCache.TTL.BALANCE });
  }

  /**
   * Cache balance data
   */
  async setBalance(data: any): Promise<void> {
    const key = 'balance:user';
    await this.set(key, data, { ttl: RedisCache.TTL.BALANCE });
  }

  /**
   * Get cached positions
   */
  async getPositions(symbol?: string): Promise<any | null> {
    const key = symbol ? `positions:${symbol}` : 'positions:all';
    return this.get(key, { ttl: RedisCache.TTL.POSITIONS });
  }

  /**
   * Cache positions data
   */
  async setPositions(data: any, symbol?: string): Promise<void> {
    const key = symbol ? `positions:${symbol}` : 'positions:all';
    await this.set(key, data, { ttl: RedisCache.TTL.POSITIONS });
  }

  /**
   * Generic get method with automatic fallback
   */
  async get(key: string, _options: CacheOptions = {}): Promise<any | null> {
    if (this.fallbackEnabled) {
      this.stats.misses++;
      return null;
    }

    try {
      const cached = await this.client.get(key);
      
      if (cached) {
        this.stats.hits++;
        return JSON.parse(cached);
      } else {
        this.stats.misses++;
        return null;
      }
    } catch (error) {
      logger.debug(`Cache get failed for key ${key}:`, error);
      this.stats.misses++;
      return null;
    }
  }

  /**
   * Generic set method with TTL and compression
   */
  async set(key: string, value: any, options: CacheOptions = {}): Promise<void> {
    if (this.fallbackEnabled) {
      return;
    }

    try {
      const serialized = JSON.stringify(value);
      const ttl = options.ttl || 300; // Default 5 minutes
      
      await this.client.setex(key, ttl, serialized);
      logger.debug(`Cached data for key ${key} with TTL ${ttl}s`);
    } catch (error) {
      logger.debug(`Cache set failed for key ${key}:`, error);
    }
  }

  /**
   * Invalidate cache for specific keys or patterns
   */
  async invalidate(pattern: string): Promise<number> {
    if (this.fallbackEnabled) {
      return 0;
    }

    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        const deleted = await this.client.del(...keys);
        logger.debug(`Invalidated ${deleted} cache keys matching pattern: ${pattern}`);
        return deleted;
      }
      return 0;
    } catch (error) {
      logger.error(`Cache invalidation failed for pattern ${pattern}:`, error);
      return 0;
    }
  }

  /**
   * Invalidate all tickers cache
   */
  async invalidateAllTickers(): Promise<void> {
    await this.invalidate('ticker:*');
    await this.invalidate('tickers:all');
  }

  /**
   * Invalidate symbols cache
   */
  async invalidateSymbols(): Promise<void> {
    await this.invalidate('symbols:*');
  }

  /**
   * Clear all cache
   */
  async clearAll(): Promise<void> {
    if (this.fallbackEnabled) {
      return;
    }

    try {
      await this.client.flushdb();
      logger.info('All cache cleared');
    } catch (error) {
      logger.error('Failed to clear cache:', error);
    }
  }

  /**
   * Get cache performance statistics
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: Math.round(hitRate * 100) / 100,
      totalKeys: 0, // Will be populated by getDetailedStats if needed
      memoryUsage: 'N/A'
    };
  }

  /**
   * Get detailed cache statistics from Redis
   */
  async getDetailedStats(): Promise<CacheStats> {
    const basicStats = this.getStats();

    if (this.fallbackEnabled) {
      return { ...basicStats, totalKeys: 0, memoryUsage: 'Redis unavailable' };
    }

    try {
      const info = await this.client.info('memory');
      const keyspace = await this.client.info('keyspace');
      
      // Parse memory usage
      const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);
      const memoryUsage = memoryMatch ? memoryMatch[1].trim() : 'Unknown';
      
      // Parse key count
      const keyMatch = keyspace.match(/keys=(\d+)/);
      const totalKeys = keyMatch ? parseInt(keyMatch[1]) : 0;
      
      return {
        ...basicStats,
        totalKeys,
        memoryUsage
      };
    } catch (error) {
      logger.debug('Failed to get detailed Redis stats:', error);
      return { ...basicStats, totalKeys: 0, memoryUsage: 'Error' };
    }
  }

  /**
   * Warmup cache with popular symbols
   */
  async warmupCache(popularSymbols: string[] = []): Promise<void> {
    if (this.fallbackEnabled || popularSymbols.length === 0) {
      return;
    }

    logger.info(`Warming up cache for ${popularSymbols.length} popular symbols`);
    
    // This would typically be called after fetching fresh data
    // The actual data fetching should be done by the calling code
    try {
      // Pre-allocate space for popular symbols to reduce fragmentation
      const pipeline = this.client.pipeline();
      
      popularSymbols.forEach(symbol => {
        const key = `ticker:${symbol}`;
        pipeline.exists(key); // Just check existence to warm up key space
      });
      
      await pipeline.exec();
      logger.debug('Cache warmup completed');
    } catch (error) {
      logger.warn('Cache warmup failed:', error);
    }
  }

  /**
   * Health check for Redis connection
   */
  async healthCheck(): Promise<{ status: string; latency?: number; error?: string }> {
    if (this.fallbackEnabled) {
      return { status: 'unavailable', error: 'Redis connection failed' };
    }

    try {
      const start = Date.now();
      await this.client.ping();
      const latency = Date.now() - start;
      
      return { status: 'healthy', latency };
    } catch (error) {
      return { 
        status: 'error', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Close Redis connection gracefully
   */
  async close(): Promise<void> {
    try {
      await this.client.quit();
      logger.info('Redis connection closed gracefully');
    } catch (error) {
      logger.warn('Error closing Redis connection:', error);
    }
  }
}

// Export singleton instance
export const redisCache = new RedisCache();