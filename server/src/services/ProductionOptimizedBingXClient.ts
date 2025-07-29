/**
 * Production-Optimized BingX Client
 * 
 * Replaces aggressive endpoint testing with intelligent, cached endpoint discovery.
 * Eliminates rate limit violations through strategic endpoint selection and caching.
 * 
 * Key Optimizations:
 * - Smart endpoint selection based on historical success
 * - Persistent endpoint caching to avoid redundant testing
 * - Fallback strategy with minimal API calls
 * - Production-grade error handling and recovery
 */

import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger, logToExternal } from '../utils/logger';
import { productionBingXRateLimiter, RequestPriority } from './ProductionBingXRateLimiter';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

interface BingXConfig {
  apiKey: string;
  secretKey: string;
  baseURL: string;
  demoMode: boolean;
}

interface EndpointMetadata {
  url: string;
  successRate: number;
  lastSuccess: number;
  avgResponseTime: number;
  totalCalls: number;
  failures: number;
}

interface CachedEndpointData {
  symbols: any[];
  tickers: any[];
  lastUpdate: number;
  source: string;
}

export class ProductionOptimizedBingXClient {
  private axios: AxiosInstance;
  private config: BingXConfig;
  private endpointCache: Map<string, EndpointMetadata> = new Map();
  private dataCache: CachedEndpointData | null = null;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  // Pre-validated endpoints based on research and testing
  private readonly PROVEN_ENDPOINTS = {
    symbols: [
      '/openApi/swap/v2/quote/contracts',  // Primary endpoint - highest success rate
      '/openApi/swap/v1/quote/contracts'   // Reliable fallback
    ],
    tickers: [
      '/openApi/swap/v2/quote/ticker',     // All tickers without params
      '/openApi/swap/v1/quote/ticker'      // v1 fallback
    ]
  };

  constructor() {
    const demoMode = process.env.DEMO_MODE === 'true';

    this.config = {
      apiKey: process.env.BINGX_API_KEY || '',
      secretKey: process.env.BINGX_SECRET_KEY || '',
      baseURL: demoMode 
        ? 'https://open-api-vst.bingx.com' 
        : process.env.BINGX_API_URL || 'https://open-api.bingx.com',
      demoMode
    };

    this.axios = axios.create({
      baseURL: this.config.baseURL,
      timeout: 15000, // Reduced timeout for faster failover
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor for authentication
    this.axios.interceptors.request.use(
      async (config) => this.addAuthentication(config),
      (error) => Promise.reject(error)
    );

    // Enhanced response interceptor with production rate limiter integration
    this.axios.interceptors.response.use(
      (response) => {
        this.updateEndpointMetrics(response.config.url!, true, response.headers);
        return response;
      },
      async (error) => {
        this.updateEndpointMetrics(error.config?.url, false);
        
        // Let the production rate limiter handle rate limit errors
        if (error.response?.status === 429 || error.response?.data?.code === 109400) {
          logger.warn('Rate limit detected, delegating to production rate limiter');
          throw error; // Let the rate limiter handle this
        }
        
        return Promise.reject(error);
      }
    );

    this.initializeEndpointCache();
    
    logger.info('🚀 Production Optimized BingX Client initialized', {
      demoMode: this.config.demoMode,
      baseURL: this.config.baseURL,
      provenEndpoints: Object.keys(this.PROVEN_ENDPOINTS).length
    });
  }

  private addAuthentication(config: any) {
    // Skip authentication for public endpoints
    const publicEndpoints = [
      '/openApi/swap/v2/quote/contracts', 
      '/openApi/swap/v2/quote/ticker', 
      '/openApi/swap/v2/quote/klines', 
      '/openApi/swap/v2/quote/depth',
      '/openApi/swap/v1/quote/contracts',
      '/openApi/swap/v1/quote/ticker'
    ];
    
    const isPublicEndpoint = publicEndpoints.some(endpoint => config.url.includes(endpoint));
    
    if (isPublicEndpoint) {
      return config;
    }

    // Add authentication for private endpoints
    if (!this.config.apiKey || !this.config.secretKey) {
      logger.warn('API credentials not configured, skipping private endpoint authentication');
      return config;
    }

    const timestamp = Date.now();
    let allParams: any = {};
    
    if (config.method === 'post' && config.data) {
      allParams = { ...config.data, timestamp };
    } else {
      if (!config.params) config.params = {};
      allParams = { ...config.params, timestamp };
    }
    
    delete allParams.signature;
    
    const sortedKeys = Object.keys(allParams).sort();
    const paramString = sortedKeys
      .map(key => `${key}=${allParams[key]}`)
      .join('&');

    const signature = crypto
      .createHmac('sha256', this.config.secretKey)
      .update(paramString)
      .digest('hex');

    if (config.method === 'post' && config.data) {
      config.data = { ...allParams, signature };
    } else {
      config.params = { ...allParams, signature };
    }
    
    config.headers['X-BX-APIKEY'] = this.config.apiKey;
    return config;
  }

  private initializeEndpointCache(): void {
    // Initialize cache with proven endpoints
    [...this.PROVEN_ENDPOINTS.symbols, ...this.PROVEN_ENDPOINTS.tickers].forEach(endpoint => {
      this.endpointCache.set(endpoint, {
        url: endpoint,
        successRate: 95, // Start with high confidence for proven endpoints
        lastSuccess: Date.now(),
        avgResponseTime: 500,
        totalCalls: 1,
        failures: 0
      });
    });
  }

  private updateEndpointMetrics(url: string | undefined, success: boolean, headers?: any): void {
    if (!url) return;
    
    const metadata = this.endpointCache.get(url) || {
      url,
      successRate: 0,
      lastSuccess: 0,
      avgResponseTime: 1000,
      totalCalls: 0,
      failures: 0
    };

    metadata.totalCalls++;
    
    if (success) {
      metadata.lastSuccess = Date.now();
      metadata.successRate = ((metadata.successRate * (metadata.totalCalls - 1)) + 100) / metadata.totalCalls;
      
      // Update response time if available
      const responseTime = headers?.['x-response-time'] || 500;
      metadata.avgResponseTime = (metadata.avgResponseTime + responseTime) / 2;
    } else {
      metadata.failures++;
      metadata.successRate = ((metadata.successRate * (metadata.totalCalls - 1)) + 0) / metadata.totalCalls;
    }

    this.endpointCache.set(url, metadata);
  }

  private selectBestEndpoint(endpoints: string[]): string {
    // Sort endpoints by success rate and recency
    const endpointMetrics = endpoints
      .map(url => this.endpointCache.get(url))
      .filter(Boolean)
      .sort((a, b) => {
        // Primary sort: success rate
        if (Math.abs(a!.successRate - b!.successRate) > 5) {
          return b!.successRate - a!.successRate;
        }
        // Secondary sort: recency of last success
        return b!.lastSuccess - a!.lastSuccess;
      });

    return endpointMetrics[0]?.url || endpoints[0];
  }

  /**
   * Optimized symbols fetching with intelligent endpoint selection
   */
  async getSymbols() {
    return productionBingXRateLimiter.executeMarketDataRequest(
      'symbols',
      async () => this.fetchSymbolsOptimized(),
      { 
        cacheSeconds: 300, // 5 minutes cache
        priority: RequestPriority.MEDIUM,
        maxRetries: 2
      }
    );
  }

  private async fetchSymbolsOptimized() {
    // Check if we have recent cached data
    if (this.dataCache && 
        Date.now() - this.dataCache.lastUpdate < this.CACHE_DURATION && 
        this.dataCache.symbols.length > 0) {
      logger.info(`📋 Using cached symbol data (${this.dataCache.symbols.length} symbols)`);
      return {
        code: 0,
        data: this.dataCache.symbols,
        msg: 'cached_success',
        source: this.dataCache.source
      };
    }

    let lastRateLimitError: any = null;
    
    // Try proven endpoints in order of success rate
    const bestEndpoint = this.selectBestEndpoint(this.PROVEN_ENDPOINTS.symbols);
    
    try {
      logger.info(`🎯 BINGX STRICT: Fetching symbols from endpoint: ${bestEndpoint}`);
      
      const response = await this.axios.get(bestEndpoint);
      
      if (response.data && response.data.code === 0 && Array.isArray(response.data.data)) {
        const symbols = response.data.data;
        
        // Update cache
        if (!this.dataCache) this.dataCache = { symbols: [], tickers: [], lastUpdate: 0, source: '' };
        this.dataCache.symbols = symbols;
        this.dataCache.lastUpdate = Date.now();
        this.dataCache.source = bestEndpoint;
        
        logger.info(`✅ BINGX: Successfully fetched ${symbols.length} symbols from ${bestEndpoint}`);
        
        return {
          code: 0,
          data: symbols,
          msg: 'success',
          source: bestEndpoint,
          cached: false
        };
      }
    } catch (error: any) {
      // BingX RATE LIMIT: Check if this is a rate limit error
      const isRateLimit = error.response?.status === 429 || 
                         error.response?.data?.code === 100410 ||
                         error.message?.includes('rate limit');
                         
      if (isRateLimit) {
        lastRateLimitError = error;
        logger.warn(`⚠️ BINGX RATE LIMIT: ${bestEndpoint} - Will try sequential fallback after delay`);
        
        // Wait before trying fallbacks (BingX compliance)
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        logger.error(`❌ BINGX: Endpoint failed (non-rate-limit): ${bestEndpoint}`, error.message);
      }
    }

    // Try fallback endpoints sequentially with delays (BingX compliance)
    const fallbackEndpoints = this.PROVEN_ENDPOINTS.symbols.filter(ep => ep !== bestEndpoint);
    
    for (const endpoint of fallbackEndpoints) {
      try {
        logger.info(`🔄 BINGX FALLBACK: Trying endpoint: ${endpoint}`);
        
        // BingX COMPLIANCE: Small delay between endpoint attempts
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const response = await this.axios.get(endpoint);
        
        if (response.data && response.data.code === 0 && Array.isArray(response.data.data)) {
          const symbols = response.data.data;
          
          // Update cache
          if (!this.dataCache) this.dataCache = { symbols: [], tickers: [], lastUpdate: 0, source: '' };
          this.dataCache.symbols = symbols;
          this.dataCache.lastUpdate = Date.now();
          this.dataCache.source = endpoint;
          
          logger.info(`✅ BINGX FALLBACK SUCCESS: ${symbols.length} symbols from ${endpoint}`);
          
          return {
            code: 0,
            data: symbols,
            msg: 'fallback_success',
            source: endpoint,
            cached: false
          };
        }
      } catch (error: any) {
        const isRateLimit = error.response?.status === 429 || 
                           error.response?.data?.code === 100410 ||
                           error.message?.includes('rate limit');
                           
        if (isRateLimit) {
          lastRateLimitError = error;
          logger.warn(`⚠️ BINGX RATE LIMIT: Fallback ${endpoint} also rate limited`);
        } else {
          logger.debug(`❌ BINGX FALLBACK FAILED: ${endpoint}`, error.message);
        }
        continue;
      }
    }

    // BingX RATE LIMIT HANDLING: If all failures were rate limits, throw specific error
    if (lastRateLimitError) {
      const retryAfter = lastRateLimitError.response?.headers['retry-after'] || '12';
      const errorMsg = `BingX rate limit active on all symbol endpoints. Recovery in ${retryAfter} seconds.`;
      
      logger.error('🚨 BINGX RATE LIMIT: All symbol endpoints rate limited', {
        triedEndpoints: this.PROVEN_ENDPOINTS.symbols,
        retryAfterSeconds: retryAfter,
        complianceMode: 'strict'
      });
      
      throw new Error(errorMsg);
    }

    // If all endpoints fail with non-rate-limit errors
    const errorMsg = 'All BingX symbol endpoints failed - API may be down';
    logger.error(errorMsg, {
      triedEndpoints: this.PROVEN_ENDPOINTS.symbols,
      endpointMetrics: Array.from(this.endpointCache.entries())
    });
    
    // Log critical failure to external monitoring
    if (process.env.NODE_ENV === 'production') {
      await logToExternal('critical', 'BingX Symbol Endpoints All Failed', {
        triedEndpoints: this.PROVEN_ENDPOINTS.symbols,
        environment: 'production',
        impact: 'symbol_data_unavailable',
        lastError: lastRateLimitError ? 'rate_limit' : 'api_failure'
      });
    }
    
    throw new Error(errorMsg);
  }

  /**
   * Optimized ticker fetching with intelligent endpoint selection
   */
  async getAllTickers() {
    return productionBingXRateLimiter.executeMarketDataRequest(
      'all_tickers',
      async () => this.fetchTickersOptimized(),
      { 
        cacheSeconds: 30, // 30 seconds cache for more frequent updates
        priority: RequestPriority.MEDIUM,
        maxRetries: 2
      }
    );
  }

  private async fetchTickersOptimized() {
    // Check if we have recent cached data
    if (this.dataCache && 
        Date.now() - this.dataCache.lastUpdate < 30000 && // 30 second cache for tickers
        this.dataCache.tickers.length > 0) {
      logger.debug(`📋 Using cached ticker data (${this.dataCache.tickers.length} tickers)`);
      return {
        code: 0,
        data: this.dataCache.tickers,
        msg: 'cached_success',
        source: this.dataCache.source
      };
    }

    let lastRateLimitError: any = null;
    
    // Try proven endpoints in order of success rate
    const bestEndpoint = this.selectBestEndpoint(this.PROVEN_ENDPOINTS.tickers);
    
    try {
      logger.info(`🎯 BINGX STRICT: Fetching tickers from endpoint: ${bestEndpoint}`);
      
      const response = await this.axios.get(bestEndpoint);
      
      if (response.data && response.data.code === 0 && Array.isArray(response.data.data)) {
        const tickers = response.data.data;
        
        // Update cache
        if (!this.dataCache) this.dataCache = { symbols: [], tickers: [], lastUpdate: 0, source: '' };
        this.dataCache.tickers = tickers;
        this.dataCache.lastUpdate = Date.now();
        this.dataCache.source = bestEndpoint;
        
        logger.info(`✅ BINGX: Successfully fetched ${tickers.length} tickers from ${bestEndpoint}`);
        
        return {
          code: 0,
          data: tickers,
          msg: 'success',
          source: bestEndpoint,
          cached: false
        };
      }
    } catch (error: any) {
      // BingX RATE LIMIT: Check if this is a rate limit error
      const isRateLimit = error.response?.status === 429 || 
                         error.response?.data?.code === 100410 ||
                         error.message?.includes('rate limit');
                         
      if (isRateLimit) {
        lastRateLimitError = error;
        logger.warn(`⚠️ BINGX RATE LIMIT: Ticker ${bestEndpoint} - Will try sequential fallback after delay`);
        
        // Wait before trying fallbacks (BingX compliance)
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        logger.error(`❌ BINGX: Ticker endpoint failed (non-rate-limit): ${bestEndpoint}`, error.message);
      }
    }

    // Try fallback endpoints sequentially with delays (BingX compliance)
    const fallbackEndpoints = this.PROVEN_ENDPOINTS.tickers.filter(ep => ep !== bestEndpoint);
    
    for (const endpoint of fallbackEndpoints) {
      try {
        logger.info(`🔄 BINGX TICKER FALLBACK: Trying endpoint: ${endpoint}`);
        
        // BingX COMPLIANCE: Small delay between endpoint attempts
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const response = await this.axios.get(endpoint);
        
        if (response.data && response.data.code === 0 && Array.isArray(response.data.data)) {
          const tickers = response.data.data;
          
          // Update cache
          if (!this.dataCache) this.dataCache = { symbols: [], tickers: [], lastUpdate: 0, source: '' };
          this.dataCache.tickers = tickers;
          this.dataCache.lastUpdate = Date.now();
          this.dataCache.source = endpoint;
          
          logger.info(`✅ BINGX TICKER FALLBACK SUCCESS: ${tickers.length} tickers from ${endpoint}`);
          
          return {
            code: 0,
            data: tickers,
            msg: 'fallback_success',
            source: endpoint,
            cached: false
          };
        }
      } catch (error: any) {
        const isRateLimit = error.response?.status === 429 || 
                           error.response?.data?.code === 100410 ||
                           error.message?.includes('rate limit');
                           
        if (isRateLimit) {
          lastRateLimitError = error;
          logger.warn(`⚠️ BINGX RATE LIMIT: Ticker fallback ${endpoint} also rate limited`);
        } else {
          logger.debug(`❌ BINGX TICKER FALLBACK FAILED: ${endpoint}`, error.message);
        }
        continue;
      }
    }

    // BingX RATE LIMIT HANDLING: If all failures were rate limits, throw specific error
    if (lastRateLimitError) {
      const retryAfter = lastRateLimitError.response?.headers['retry-after'] || '12';
      const errorMsg = `BingX rate limit active on all ticker endpoints. Recovery in ${retryAfter} seconds.`;
      
      logger.error('🚨 BINGX RATE LIMIT: All ticker endpoints rate limited', {
        triedEndpoints: this.PROVEN_ENDPOINTS.tickers,
        retryAfterSeconds: retryAfter,
        complianceMode: 'strict'
      });
      
      throw new Error(errorMsg);
    }

    // If all endpoints fail with non-rate-limit errors
    const errorMsg = 'All BingX ticker endpoints failed - API may be down';
    logger.error(errorMsg, {
      triedEndpoints: this.PROVEN_ENDPOINTS.tickers,
      endpointMetrics: Array.from(this.endpointCache.entries())
    });
    
    // Log critical failure to external monitoring
    if (process.env.NODE_ENV === 'production') {
      await logToExternal('critical', 'BingX Ticker Endpoints All Failed', {
        triedEndpoints: this.PROVEN_ENDPOINTS.tickers,
        environment: 'production',
        impact: 'ticker_data_unavailable',
        lastError: lastRateLimitError ? 'rate_limit' : 'api_failure'
      });
    }
    
    throw new Error(errorMsg);
  }

  /**
   * Optimized combined fetch for symbols and tickers
   */
  async getSymbolsAndTickersOptimized() {
    return productionBingXRateLimiter.executeMarketDataRequest(
      'symbols_and_tickers_combined',
      async () => {
        // Execute both requests in parallel with production rate limiter
        const [symbolsResult, tickersResult] = await Promise.all([
          this.fetchSymbolsOptimized(),
          this.fetchTickersOptimized()
        ]);

        const result = {
          symbols: symbolsResult,
          tickers: tickersResult,
          timestamp: Date.now(),
          source: 'optimized_parallel_production'
        };

        logger.info(`🚀 OPTIMIZED PARALLEL COMPLETED: ${symbolsResult?.data?.length || 0} symbols + ${tickersResult?.data?.length || 0} tickers`);
        
        return result;
      },
      { 
        cacheSeconds: 60, // 1 minute cache for combined data
        priority: RequestPriority.MEDIUM,
        maxRetries: 1 // Lower retries since individual methods have their own retries
      }
    );
  }

  /**
   * Individual ticker request
   */
  async getTicker(symbol: string) {
    return productionBingXRateLimiter.executeMarketDataRequest(
      `ticker:${symbol}`,
      async () => {
        const response = await this.axios.get('/openApi/swap/v2/quote/ticker', {
          params: { symbol }
        });
        return response.data;
      },
      {
        cacheSeconds: 10, // 10 second cache for individual tickers
        priority: RequestPriority.MEDIUM
      }
    );
  }

  /**
   * Trading operations - use account rate limiter
   */
  async placeOrder(orderData: any) {
    return productionBingXRateLimiter.executeAccountRequest(
      `place_order:${orderData.symbol}:${Date.now()}`,
      async () => {
        const response = await this.axios.post('/openApi/swap/v2/trade/order', orderData);
        return response.data;
      },
      {
        priority: RequestPriority.CRITICAL,
        maxRetries: 3
      }
    );
  }

  async getPositions(symbol?: string) {
    return productionBingXRateLimiter.executeAccountRequest(
      `positions:${symbol || 'all'}`,
      async () => {
        const params = symbol ? { symbol } : {};
        const response = await this.axios.get('/openApi/swap/v2/user/positions', { params });
        return response.data;
      },
      {
        cacheSeconds: 5, // 5 second cache for positions
        priority: RequestPriority.HIGH
      }
    );
  }

  async getBalance() {
    return productionBingXRateLimiter.executeAccountRequest(
      'balance',
      async () => {
        const response = await this.axios.get('/openApi/swap/v2/user/balance');
        return response.data;
      },
      {
        cacheSeconds: 10, // 10 second cache for balance
        priority: RequestPriority.HIGH
      }
    );
  }

  // Additional methods for compatibility with existing BingXClient interface
  async getKlines(symbol: string, interval: string, limit: number = 500) {
    return productionBingXRateLimiter.executeMarketDataRequest(
      `klines:${symbol}:${interval}:${limit}`,
      async () => {
        const response = await this.axios.get('/openApi/swap/v2/quote/klines', {
          params: { symbol, interval, limit }
        });
        return response.data;
      },
      {
        cacheSeconds: 30,
        priority: RequestPriority.MEDIUM
      }
    );
  }

  async getDepth(symbol: string, limit: number = 20) {
    return productionBingXRateLimiter.executeMarketDataRequest(
      `depth:${symbol}:${limit}`,
      async () => {
        const response = await this.axios.get('/openApi/swap/v2/quote/depth', {
          params: { symbol, limit }
        });
        return response.data;
      },
      {
        cacheSeconds: 5,
        priority: RequestPriority.MEDIUM
      }
    );
  }

  async cancelOrder(symbol: string, orderId: string) {
    return productionBingXRateLimiter.executeAccountRequest(
      `cancel_order:${symbol}:${orderId}`,
      async () => {
        const response = await this.axios.delete('/openApi/swap/v2/trade/order', {
          params: { symbol, orderId }
        });
        return response.data;
      },
      {
        priority: RequestPriority.CRITICAL,
        maxRetries: 3
      }
    );
  }

  async getOpenOrders(symbol?: string) {
    return productionBingXRateLimiter.executeAccountRequest(
      `open_orders:${symbol || 'all'}`,
      async () => {
        const params = symbol ? { symbol } : {};
        const response = await this.axios.get('/openApi/swap/v2/trade/openOrders', { params });
        return response.data;
      },
      {
        cacheSeconds: 5,
        priority: RequestPriority.HIGH
      }
    );
  }

  /**
   * Get comprehensive status including rate limiter status
   */
  getStatus() {
    const rateLimiterStatus = productionBingXRateLimiter.getStatus();
    
    return {
      ...rateLimiterStatus,
      client: {
        endpointCache: Array.from(this.endpointCache.entries()).map(([url, metrics]) => ({
          ...metrics,
          url,
          lastSuccessAge: Date.now() - metrics.lastSuccess
        })),
        dataCache: this.dataCache ? {
          hasSymbols: this.dataCache.symbols.length > 0,
          hasTickers: this.dataCache.tickers.length > 0,
          age: Date.now() - this.dataCache.lastUpdate,
          source: this.dataCache.source
        } : null,
        config: {
          demoMode: this.config.demoMode,
          baseURL: this.config.baseURL,
          hasCredentials: !!(this.config.apiKey && this.config.secretKey)
        }
      }
    };
  }

  /**
   * Get rate limit status for backward compatibility
   */
  getRateLimitStatus() {
    return productionBingXRateLimiter.getStatus();
  }

  /**
   * Clear all caches and reset metrics
   */
  clearCache() {
    this.dataCache = null;
    this.initializeEndpointCache();
    productionBingXRateLimiter.restart();
    logger.info('🗑️ Production optimized client cache cleared and rate limiter restarted');
  }

  // WebSocket related methods for compatibility
  async createListenKey() {
    return productionBingXRateLimiter.executeAccountRequest(
      'create_listen_key',
      async () => {
        const response = await this.axios.post('/openApi/user/auth/userDataStream');
        return response.data;
      },
      {
        priority: RequestPriority.HIGH,
        maxRetries: 3
      }
    );
  }

  async keepAliveListenKey(listenKey: string) {
    return productionBingXRateLimiter.executeAccountRequest(
      `keep_alive_listen_key:${listenKey}`,
      async () => {
        const response = await this.axios.put('/openApi/user/auth/userDataStream', { listenKey });
        return response.data;
      },
      {
        priority: RequestPriority.HIGH
      }
    );
  }

  async closeListenKey(listenKey: string) {
    return productionBingXRateLimiter.executeAccountRequest(
      `close_listen_key:${listenKey}`,
      async () => {
        const response = await this.axios.delete('/openApi/user/auth/userDataStream', {
          params: { listenKey }
        });
        return response.data;
      },
      {
        priority: RequestPriority.MEDIUM
      }
    );
  }

  // Close position method for compatibility
  async closePosition(symbol: string, percentage: number = 100) {
    try {
      // Get current position
      const positions = await this.getPositions();
      if (positions.code !== 0 || !positions.data) {
        throw new Error('Failed to get current positions');
      }

      const position = positions.data.find((pos: any) => pos.symbol === symbol);
      if (!position || parseFloat(position.positionAmt) === 0) {
        throw new Error(`No active position found for ${symbol}`);
      }

      const positionAmt = parseFloat(position.positionAmt);
      const isLong = position.positionSide === 'LONG';
      const currentSize = Math.abs(positionAmt);
      const closeQuantity = (currentSize * percentage) / 100;

      const orderData = {
        symbol: position.symbol,
        side: isLong ? 'SELL' : 'BUY' as 'BUY' | 'SELL',
        positionSide: position.positionSide,
        type: 'MARKET' as const,
        quantity: parseFloat(closeQuantity.toFixed(6))
      };
      
      return await this.placeOrder(orderData);
    } catch (error) {
      logger.error(`Failed to close position ${symbol}:`, error);
      throw error;
    }
  }
}

// Export singleton instance
export const productionOptimizedBingXClient = new ProductionOptimizedBingXClient();