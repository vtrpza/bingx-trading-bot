import { EventEmitter } from 'events';
import { bingxClient } from '../services/bingxClient';
import { logger } from '../utils/logger';
import WebSocket from 'ws';
import { inflate } from 'zlib';
import { promisify } from 'util';

export interface CachedTickerData {
  symbol: string;
  lastPrice: number;
  priceChange: number;
  priceChangePercent: number;
  volume: number;
  quoteVolume: number;
  lastUpdate: number;
  bidPrice?: number;
  askPrice?: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
}

export interface CachedKlineData {
  symbol: string;
  interval: string;
  data: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  lastUpdate: number;
}

export interface MarketDataCacheConfig {
  tickerCacheTTL: number; // TTL for ticker data in milliseconds
  klineCacheTTL: number; // TTL for kline data in milliseconds
  maxCacheSize: number; // Maximum number of symbols to cache
  websocketReconnectDelay: number;
  batchUpdateInterval: number;
  priceChangeThreshold: number; // Percentage change to trigger updates
}

export interface CacheMetrics {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  websocketUpdates: number;
  apiCalls: number;
  lastUpdate: number;
  connectedStreams: number;
}

export class MarketDataCache extends EventEmitter {
  private tickerCache: Map<string, CachedTickerData> = new Map();
  private klineCache: Map<string, CachedKlineData> = new Map();
  private config: MarketDataCacheConfig;
  private metrics: CacheMetrics;
  private websockets: Map<string, WebSocket> = new Map();
  private isRunning: boolean = false;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private subscribedSymbols: Set<string> = new Set();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: Partial<MarketDataCacheConfig> = {}) {
    super();
    
    this.config = {
      tickerCacheTTL: 120000, // 🚀 2 minutes - extended for batch processing
      klineCacheTTL: 900000, // 🚀 15 minutes - ULTRA long cache for symbol scanning
      maxCacheSize: 500, // 🚀 500 symbols - massive cache for all scanning symbols
      websocketReconnectDelay: 2000, // 🚀 2 seconds - even faster reconnects
      batchUpdateInterval: 300, // 🚀 300ms - ultra-fast updates
      priceChangeThreshold: 0.05, // More sensitive change detection
      ...config
    };

    this.metrics = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      websocketUpdates: 0,
      apiCalls: 0,
      lastUpdate: 0,
      connectedStreams: 0
    };

    this.startCleanupProcess();
  }

  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    logger.info('MarketDataCache started');
  }

  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    // Close all WebSocket connections
    for (const [symbol] of this.websockets) {
      this.closeWebSocket(symbol);
    }
    
    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Clear reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    logger.info('MarketDataCache stopped');
  }

  async getTicker(symbol: string, useCache: boolean = true): Promise<CachedTickerData> {
    this.metrics.totalRequests++;

    if (useCache) {
      const cached = this.tickerCache.get(symbol);
      if (cached && this.isTickerValid(cached)) {
        this.metrics.cacheHits++;
        return cached;
      }
    }

    this.metrics.cacheMisses++;
    this.metrics.apiCalls++;

    try {
      const response = await bingxClient.getTicker(symbol);
      
      if (!response.data) {
        throw new Error('Invalid ticker response');
      }

      const tickerData: CachedTickerData = {
        symbol,
        lastPrice: parseFloat(response.data.lastPrice),
        priceChange: parseFloat(response.data.priceChange || '0'),
        priceChangePercent: parseFloat(response.data.priceChangePercent || '0'),
        volume: parseFloat(response.data.volume || '0'),
        quoteVolume: parseFloat(response.data.quoteVolume || '0'),
        bidPrice: parseFloat(response.data.bidPrice || '0'),
        askPrice: parseFloat(response.data.askPrice || '0'),
        openPrice: parseFloat(response.data.openPrice || '0'),
        highPrice: parseFloat(response.data.highPrice24h || '0'),
        lowPrice: parseFloat(response.data.lowPrice24h || '0'),
        lastUpdate: Date.now()
      };

      this.tickerCache.set(symbol, tickerData);
      this.ensureCacheSize();

      // Subscribe to WebSocket updates if not already subscribed
      if (!this.subscribedSymbols.has(symbol)) {
        this.subscribeToSymbol(symbol);
      }

      return tickerData;
    } catch (error) {
      logger.error(`Failed to fetch ticker for ${symbol}:`, error);
      throw error;
    }
  }

  async getKlines(symbol: string, interval: string = '5m', limit: number = 100, useCache: boolean = true): Promise<CachedKlineData> {
    this.metrics.totalRequests++;
    const cacheKey = `${symbol}_${interval}`;

    if (useCache) {
      const cached = this.klineCache.get(cacheKey);
      if (cached && this.isKlineValid(cached)) {
        this.metrics.cacheHits++;
        return cached;
      }
    }

    this.metrics.cacheMisses++;
    this.metrics.apiCalls++;

    try {
      const response = await bingxClient.getKlines(symbol, interval, limit);
      
      if (!response.data || !Array.isArray(response.data)) {
        throw new Error('Invalid klines response');
      }

      const klineData: CachedKlineData = {
        symbol,
        interval,
        data: response.data.map((k: any) => ({
          timestamp: parseInt(k.time || k[0]),
          open: parseFloat(k.open !== undefined ? k.open : k[1]),
          high: parseFloat(k.high !== undefined ? k.high : k[2]),
          low: parseFloat(k.low !== undefined ? k.low : k[3]),
          close: parseFloat(k.close !== undefined ? k.close : k[4]),
          volume: parseFloat(k.volume !== undefined ? k.volume : k[5])
        })),
        lastUpdate: Date.now()
      };

      this.klineCache.set(cacheKey, klineData);
      this.ensureCacheSize();

      return klineData;
    } catch (error) {
      logger.error(`Failed to fetch klines for ${symbol}:`, error);
      throw error;
    }
  }

  subscribeToSymbol(symbol: string): void {
    if (this.subscribedSymbols.has(symbol) || !this.isRunning) {
      return;
    }

    try {
      // BingX WebSocket URL for ticker stream
      const wsUrl = `wss://open-api-ws.bingx.com/market?symbol=${symbol}`;
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        logger.debug(`WebSocket connected for ${symbol}`);
        this.subscribedSymbols.add(symbol);
        this.metrics.connectedStreams++;
        
        // Send subscription message
        const subscribeMsg = {
          id: Date.now(),
          reqType: 'sub',
          dataType: `${symbol}@ticker`
        };
        
        ws.send(JSON.stringify(subscribeMsg));
        
        this.emit('symbolSubscribed', symbol);
      });

      ws.on('message', async (data: Buffer) => {
        try {
          let messageStr: string;
          
          // Check if data is compressed (starts with gzip magic bytes)
          if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
            try {
              const inflateAsync = promisify(inflate);
              const decompressed = await inflateAsync(data);
              messageStr = decompressed.toString();
            } catch (decompressError) {
              // If decompression fails, try as plain text
              messageStr = data.toString();
            }
          } else {
            // Try parsing as plain text first
            messageStr = data.toString();
            
            // If it's not valid UTF-8, skip this message
            if (messageStr.includes('\u0000') || messageStr.length === 0) {
              logger.debug(`Skipping invalid WebSocket message for ${symbol} (binary data)`);
              return;
            }
          }
          
          const message = JSON.parse(messageStr);
          this.handleWebSocketMessage(symbol, message);
        } catch (error: any) {
          // Only log if it's not a common binary data error
          if (!error.message?.includes('Unexpected token') || !error.message?.includes('\u001f')) {
            logger.debug(`Failed to parse WebSocket message for ${symbol}:`, error);
          }
        }
      });

      ws.on('error', (error) => {
        // Properly handle error objects - don't serialize the entire error
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`WebSocket error for ${symbol}: ${errorMessage}`);
        this.handleWebSocketError(symbol);
      });

      ws.on('close', () => {
        logger.debug(`WebSocket closed for ${symbol}`);
        this.handleWebSocketClose(symbol);
      });

      this.websockets.set(symbol, ws);
      
    } catch (error) {
      logger.error(`Failed to create WebSocket for ${symbol}:`, error);
    }
  }

  private handleWebSocketMessage(symbol: string, message: any): void {
    try {
      // Handle ticker updates
      if (message.dataType && message.dataType.includes('ticker') && message.data) {
        const data = message.data;
        
        const tickerData: CachedTickerData = {
          symbol,
          lastPrice: parseFloat(data.c || data.lastPrice),
          priceChange: parseFloat(data.P || data.priceChange || '0'),
          priceChangePercent: parseFloat(data.p || data.priceChangePercent || '0'),
          volume: parseFloat(data.v || data.volume || '0'),
          quoteVolume: parseFloat(data.q || data.quoteVolume || '0'),
          bidPrice: parseFloat(data.b || data.bidPrice || '0'),
          askPrice: parseFloat(data.a || data.askPrice || '0'),
          openPrice: parseFloat(data.o || data.openPrice || '0'),
          highPrice: parseFloat(data.h || data.highPrice || '0'),
          lowPrice: parseFloat(data.l || data.lowPrice || '0'),
          lastUpdate: Date.now()
        };

        // Check if price change is significant
        const existingData = this.tickerCache.get(symbol);
        if (existingData) {
          const priceChange = Math.abs(
            (tickerData.lastPrice - existingData.lastPrice) / existingData.lastPrice * 100
          );
          
          if (priceChange >= this.config.priceChangeThreshold) {
            this.emit('significantPriceChange', {
              symbol,
              oldPrice: existingData.lastPrice,
              newPrice: tickerData.lastPrice,
              changePercent: priceChange
            });
          }
        }

        this.tickerCache.set(symbol, tickerData);
        this.metrics.websocketUpdates++;
        this.metrics.lastUpdate = Date.now();
        
        this.emit('tickerUpdate', tickerData);
      }
    } catch (error) {
      logger.debug(`Error processing WebSocket message for ${symbol}:`, error);
    }
  }

  private handleWebSocketError(symbol: string): void {
    this.closeWebSocket(symbol);
    this.scheduleReconnect(symbol);
  }

  private handleWebSocketClose(symbol: string): void {
    this.closeWebSocket(symbol);
    
    if (this.isRunning && this.subscribedSymbols.has(symbol)) {
      this.scheduleReconnect(symbol);
    }
  }

  private closeWebSocket(symbol: string): void {
    const ws = this.websockets.get(symbol);
    if (ws) {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      this.websockets.delete(symbol);
    }
    
    this.subscribedSymbols.delete(symbol);
    this.metrics.connectedStreams = Math.max(0, this.metrics.connectedStreams - 1);
  }

  private scheduleReconnect(symbol: string): void {
    if (this.reconnectTimers.has(symbol) || !this.isRunning) {
      return;
    }

    // Exponential backoff for repeated failures
    const reconnectDelay = this.config.websocketReconnectDelay;
    
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(symbol);
      
      if (this.isRunning && this.subscribedSymbols.has(symbol)) {
        logger.debug(`Attempting to reconnect WebSocket for ${symbol}`);
        this.subscribeToSymbol(symbol);
      }
    }, reconnectDelay);

    this.reconnectTimers.set(symbol, timer);
  }

  private isTickerValid(ticker: CachedTickerData): boolean {
    return (Date.now() - ticker.lastUpdate) < this.config.tickerCacheTTL;
  }

  private isKlineValid(kline: CachedKlineData): boolean {
    return (Date.now() - kline.lastUpdate) < this.config.klineCacheTTL;
  }

  private ensureCacheSize(): void {
    // Remove oldest entries if cache is too large
    if (this.tickerCache.size > this.config.maxCacheSize) {
      const oldest = Array.from(this.tickerCache.entries())
        .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate)[0];
      
      this.tickerCache.delete(oldest[0]);
      this.closeWebSocket(oldest[0]);
    }

    if (this.klineCache.size > this.config.maxCacheSize) {
      const oldest = Array.from(this.klineCache.entries())
        .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate)[0];
      
      this.klineCache.delete(oldest[0]);
    }
  }

  private startCleanupProcess(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredData();
    }, 10000); // Clean every 10 seconds
  }

  private cleanupExpiredData(): void {
    const now = Date.now();
    let removedTickers = 0;
    let removedKlines = 0;

    // Clean expired ticker data
    for (const [symbol, ticker] of this.tickerCache) {
      if (now - ticker.lastUpdate > this.config.tickerCacheTTL * 2) {
        this.tickerCache.delete(symbol);
        this.closeWebSocket(symbol);
        removedTickers++;
      }
    }

    // Clean expired kline data
    for (const [key, kline] of this.klineCache) {
      if (now - kline.lastUpdate > this.config.klineCacheTTL * 2) {
        this.klineCache.delete(key);
        removedKlines++;
      }
    }

    if (removedTickers > 0 || removedKlines > 0) {
      logger.debug(`Cleaned expired cache data: ${removedTickers} tickers, ${removedKlines} klines`);
    }
  }

  unsubscribeFromSymbol(symbol: string): void {
    this.closeWebSocket(symbol);
    logger.debug(`Unsubscribed from ${symbol}`);
  }

  invalidateCache(symbol?: string): void {
    if (symbol) {
      this.tickerCache.delete(symbol);
      
      // Remove klines for the symbol
      for (const key of this.klineCache.keys()) {
        if (key.startsWith(symbol + '_')) {
          this.klineCache.delete(key);
        }
      }
      
      logger.debug(`Cache invalidated for ${symbol}`);
    } else {
      this.tickerCache.clear();
      this.klineCache.clear();
      logger.debug('All cache data invalidated');
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      cachedTickers: this.tickerCache.size,
      cachedKlines: this.klineCache.size,
      subscribedSymbols: Array.from(this.subscribedSymbols),
      connectedStreams: this.metrics.connectedStreams,
      metrics: { ...this.metrics },
      config: this.config
    };
  }

  getMetrics() {
    const hitRate = this.metrics.totalRequests > 0 
      ? (this.metrics.cacheHits / this.metrics.totalRequests) * 100 
      : 0;

    return {
      ...this.metrics,
      hitRate,
      missRate: 100 - hitRate
    };
  }

  updateConfig(newConfig: Partial<MarketDataCacheConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('MarketDataCache configuration updated');
  }

  /**
   * Emergency stop during circuit breaker
   */
  emergencyStop(): void {
    logger.warn('MarketDataCache emergency stop initiated');
    
    // Close all WebSocket connections immediately
    for (const [symbol] of this.websockets) {
      this.closeWebSocket(symbol);
    }
    
    // Clear all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    
    // Clear caches to prevent stale data
    this.tickerCache.clear();
    this.klineCache.clear();
    
    // Reset metrics
    this.metrics.connectedStreams = 0;
    
    logger.info('MarketDataCache emergency stop completed');
  }

  // 🚀 ULTRA-FAST Batch operations for maximum efficiency
  async preloadSymbols(symbols: string[]): Promise<void> {
    const batchSize = 20; // 🚀 4x larger batches
    const startTime = Date.now();
    
    logger.info(`🚀 ULTRA-FAST: Preloading ${symbols.length} symbols with ${batchSize} parallel requests...`);
    
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      
      const promises = batch.map(symbol => 
        this.getTicker(symbol, false).catch(error => {
          // Silent fail for speed during preloading
          if (!error.message?.includes('timeout')) {
            logger.debug(`Preload failed for ${symbol}:`, error.message);
          }
          return null;
        })
      );
      
      // Execute all in parallel without delays
      await Promise.allSettled(promises);
      
      // 🚀 NO DELAYS: Let the rate limiter handle spacing
      // Progress logging every 100 symbols
      if (i % 100 === 0 && i > 0) {
        const progress = (i / symbols.length * 100).toFixed(1);
        const elapsed = Date.now() - startTime;
        const rate = i / (elapsed / 1000);
        logger.info(`📊 Preload progress: ${progress}% at ${rate.toFixed(1)} symbols/sec`);
      }
    }
    
    const totalTime = Date.now() - startTime;
    const rate = symbols.length / (totalTime / 1000);
    logger.info(`⚡ PRELOAD COMPLETE: ${symbols.length} symbols in ${totalTime}ms (${rate.toFixed(1)} symbols/sec)`);
  }
}