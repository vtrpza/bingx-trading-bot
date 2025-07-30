import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger, logToExternal } from '../utils/logger';
import { productionBingXRateLimiter, RequestPriority } from './ProductionBingXRateLimiter';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Legacy cache maps (now replaced by BingXRateLimiter caching)

interface BingXConfig {
  apiKey: string;
  secretKey: string;
  baseURL: string;
  demoMode: boolean;
}

export class BingXClient {
  private axios: AxiosInstance;
  private config: BingXConfig;


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

    // Debug API key loading
    logger.info('BingX Client initialized', {
      hasApiKey: !!this.config.apiKey,
      hasSecretKey: !!this.config.secretKey,
      demoMode: this.config.demoMode,
      apiKeyLength: this.config.apiKey ? this.config.apiKey.length : 0,
      secretKeyLength: this.config.secretKey ? this.config.secretKey.length : 0,
      baseURL: this.config.baseURL,
      apiKeyStart: this.config.apiKey ? this.config.apiKey.substring(0, 8) + '...' : 'NOT_SET'
    });

    this.axios = axios.create({
      baseURL: this.config.baseURL,
      timeout: 30000, // Increased to 30s for batch operations and slower responses
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor for authentication only (rate limiting handled per method)
    this.axios.interceptors.request.use(
      async (config) => {
        return this.addAuthentication(config);
      },
      (error) => Promise.reject(error)
    );

    // Add response interceptor for error handling with new rate limiter
    this.axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;
        
        // Handle rate limiting with new comprehensive system
        if ((error.response?.status === 429 || error.response?.data?.code === 109400) && !originalRequest._retried) {
          originalRequest._retried = true;
          
          logger.warn('BingX rate limit exceeded, using comprehensive rate limiter backoff', {
            url: originalRequest.url,
            status: error.response?.status,
            code: error.response?.data?.code,
            message: error.response?.data?.msg
          });
          
          // Rate limiting is handled internally by the rate limiter
          originalRequest._retryCount = (originalRequest._retryCount || 1) + 1;
          
          // Retry the original request
          return this.axios(originalRequest);
        }
        
        logger.error('BingX API Error:', {
          status: error.response?.status,
          code: error.response?.data?.code,
          message: error.response?.data?.msg,
          url: error.config?.url
        });
        return Promise.reject(error);
      }
    );
  }

  private addAuthentication(config: any) {
    // Skip authentication for public endpoints
    const publicEndpoints = ['/openApi/swap/v2/quote/contracts', '/openApi/swap/v2/quote/ticker', '/openApi/swap/v2/quote/klines', '/openApi/swap/v2/quote/depth'];
    const isPublicEndpoint = publicEndpoints.some(endpoint => config.url.includes(endpoint));
    
    if (isPublicEndpoint) {
      return config;
    }

    // Only add auth for private endpoints
    if (!this.config.apiKey || !this.config.secretKey) {
      logger.warn('API credentials not configured, skipping private endpoint authentication');
      return config;
    }

    // Add timestamp
    const timestamp = Date.now();

    // For POST requests, move data to params for signature generation
    let allParams: any = {};
    
    if (config.method === 'post' && config.data) {
      // For POST requests, use data body for signature
      allParams = { ...config.data, timestamp };
    } else {
      // For GET/DELETE requests, use query params
      if (!config.params) {
        config.params = {};
      }
      allParams = { ...config.params, timestamp };
    }
    
    // Remove signature if it exists
    delete allParams.signature;
    
    // Sort parameters alphabetically by key (critical for BingX)
    const sortedKeys = Object.keys(allParams).sort();
    
    // Build parameter string with sorted keys
    const paramString = sortedKeys
      .map(key => `${key}=${allParams[key]}`)
      .join('&');

    // Generate signature using HMAC-SHA256
    const signature = crypto
      .createHmac('sha256', this.config.secretKey)
      .update(paramString)
      .digest('hex');

    // Add signature based on request method
    if (config.method === 'post' && config.data) {
      // For POST, add to data body
      config.data = { ...allParams, signature };
    } else {
      // For GET/DELETE, add to params
      config.params = { ...allParams, signature };
    }
    
    config.headers['X-BX-APIKEY'] = this.config.apiKey;

    // Log signature details for debugging
    logger.debug('BingX Authentication Debug:', {
      method: config.method,
      paramString,
      signature: signature.substring(0, 10) + '...', // Only show first 10 chars for security
      timestamp,
      sortedKeys,
      url: config.url,
      hasData: !!config.data,
      hasParams: !!config.params
    });

    return config;
  }


  // OPTIMIZED: Controlled parallel API calls with rate limiting
  async getSymbolsAndTickersOptimized() {
    
    // Use production rate limiter's batch execution for controlled parallelism
    const results = await Promise.all([
      productionBingXRateLimiter.executeMarketDataRequest('symbols', () => this.fetchSymbolsFromAPI(), { cacheSeconds: 60 }),
      productionBingXRateLimiter.executeMarketDataRequest('all_tickers', () => this.fetchTickersFromAPI(), { cacheSeconds: 30 })
    ]);
    
    const [symbolsResult, tickersResult] = results as [any, any];
    
    const result = {
      symbols: symbolsResult,
      tickers: tickersResult,
      timestamp: Date.now(),
      source: 'optimized_parallel_rate_limited'
    };
    
    logger.info(`🚀 OPTIMIZED PARALLEL COMPLETED: ${symbolsResult?.data?.length || 0} symbols + ${tickersResult?.data?.length || 0} tickers`);
    return result;
  }

  // Market Data Methods (Public)
  async getSymbols() {
    const cacheKey = 'symbols';
    
    return productionBingXRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => this.fetchSymbolsFromAPI(),
      { cacheSeconds: 60, priority: RequestPriority.MEDIUM }
    );
  }
  
  private async fetchSymbolsFromAPI() {
    // PRODUCTION-OPTIMIZED: Use proven endpoints only to avoid rate limits
    const PROVEN_ENDPOINTS = [
      '/openApi/swap/v2/quote/contracts',  // Primary endpoint - highest success rate
      '/openApi/swap/v1/quote/contracts'   // Reliable fallback
    ];
    
    try {
      logger.info('🎯 Fetching symbols from production-optimized endpoints');
      
      // Try proven endpoints in order
      for (const endpoint of PROVEN_ENDPOINTS) {
        try {
          logger.debug(`🔍 Trying endpoint: ${endpoint}`);
          
          const response = await this.axios.get(endpoint);
          
          if (response.data && response.data.code === 0 && Array.isArray(response.data.data)) {
            const contracts = response.data.data;
            
            logger.info(`✅ Successfully fetched ${contracts.length} symbols from ${endpoint}`);
            
            return {
              code: 0,
              data: contracts,
              msg: 'success',
              source: endpoint,
              total: contracts.length,
              timestamp: Date.now()
            };
          }
        } catch (error: any) {
          logger.warn(`❌ Endpoint failed: ${endpoint}`, error.message);
          
          // Log to external monitoring for production debugging
          if (process.env.NODE_ENV === 'production') {
            await logToExternal('warn', `BingX symbol endpoint failed: ${endpoint}`, {
              error: error.message,
              code: error.code,
              status: error.response?.status,
              timeout: error.code === 'ECONNABORTED'
            });
          }
          
          continue; // Try next endpoint
        }
      }
      
      // If all endpoints fail
      const errorMsg = 'All proven symbol endpoints failed';
      logger.error(errorMsg);
      
      if (process.env.NODE_ENV === 'production') {
        await logToExternal('error', 'BingX Symbol Endpoints Critical Failure', {
          triedEndpoints: PROVEN_ENDPOINTS,
          environment: 'production',
          impact: 'symbol_data_unavailable'
        });
      }
      
      throw new Error(errorMsg);
      
    } catch (error) {
      logger.error('Failed to fetch symbols:', error);
      throw error;
    }
  }
  
  


  async getTicker(symbol: string) {
    const cacheKey = `ticker:${symbol}`;
    
    return productionBingXRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => {
        const apiSymbol = symbol;
        const response = await this.axios.get('/openApi/swap/v2/quote/ticker', {
          params: { symbol: apiSymbol }
        });
        return response.data;
      },
      { cacheSeconds: 30, priority: RequestPriority.MEDIUM }
    );
  }

  async getAllTickers() {
    const cacheKey = 'all_tickers';
    
    return productionBingXRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => this.fetchTickersFromAPI(),
      { cacheSeconds: 30, priority: RequestPriority.MEDIUM }
    );
  }
  
  private async fetchTickersFromAPI() {
    // PRODUCTION-OPTIMIZED: Use proven endpoints only to avoid rate limits
    const PROVEN_TICKER_ENDPOINTS = [
      '/openApi/swap/v2/quote/ticker',    // All tickers without symbol param - primary
      '/openApi/swap/v1/quote/ticker'     // v1 fallback
    ];
    
    try {
      logger.info('🎯 Fetching ticker data from production-optimized endpoints');
      
      // Try proven endpoints in order
      for (const endpoint of PROVEN_TICKER_ENDPOINTS) {
        try {
          logger.debug(`🔍 Trying ticker endpoint: ${endpoint}`);
          
          const response = await this.axios.get(endpoint);
          
          if (response.data && response.data.code === 0) {
            const tickers = response.data.data;
            
            if (Array.isArray(tickers) && tickers.length > 0) {
              logger.info(`✅ Successfully fetched ${tickers.length} tickers from ${endpoint}`);
              
              return {
                code: 0,
                data: tickers,
                msg: 'success',
                endpoint: endpoint,
                count: tickers.length,
                timestamp: Date.now()
              };
            }
          }
          
        } catch (error: any) {
          logger.warn(`❌ Ticker endpoint failed: ${endpoint}`, error.message);
          
          // Log to external service for production debugging
          if (process.env.NODE_ENV === 'production') {
            await logToExternal('warn', `BingX ticker endpoint failed: ${endpoint}`, {
              error: error.message,
              code: error.code,
              status: error.response?.status,
              timeout: error.code === 'ECONNABORTED'
            });
          }
          
          continue; // Try next endpoint
        }
      }
      
      // If all endpoints fail
      const errorMsg = 'All proven ticker endpoints failed';
      logger.error(errorMsg);
      
      if (process.env.NODE_ENV === 'production') {
        await logToExternal('error', 'BingX Ticker Endpoints Critical Failure', {
          triedEndpoints: PROVEN_TICKER_ENDPOINTS,
          environment: 'production',
          impact: 'ticker_data_unavailable'
        });
      }
      
      throw new Error(errorMsg);
      
    } catch (error) {
      logger.error('Failed to get all tickers:', error);
      throw error;
    }
  }

  async getKlines(symbol: string, interval: string, limit: number = 500) {
    const cacheKey = `klines:${symbol}:${interval}:${limit}`;
    
    return productionBingXRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => {
        const apiSymbol = symbol;
        const response = await this.axios.get('/openApi/swap/v2/quote/klines', {
          params: { symbol: apiSymbol, interval, limit }
        });
        return response.data;
      },
      { cacheSeconds: 30, priority: RequestPriority.MEDIUM }
    );
  }

  async getDepth(symbol: string, limit: number = 20) {
    const cacheKey = `depth:${symbol}:${limit}`;
    
    return productionBingXRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => {
        const apiSymbol = symbol;
        const response = await this.axios.get('/openApi/swap/v2/quote/depth', {
          params: { symbol: apiSymbol, limit }
        });
        return response.data;
      },
      { cacheSeconds: 5, priority: RequestPriority.MEDIUM }
    );
  }

  // Trading Methods (Private)
  async placeOrder(orderData: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide?: 'LONG' | 'SHORT';
    type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity: number;
    price?: number;
    stopPrice?: number;
    takeProfit?: number;
    stopLoss?: number;
  }) {
    return productionBingXRateLimiter.executeAccountRequest(
      `place_order:${orderData.symbol}:${Date.now()}`,
      async () => {
      // VST mode (DEMO_MODE=true) sends real orders to BingX with virtual balance
      const orderParams: any = {
        symbol: orderData.symbol,
        side: orderData.side,
        type: orderData.type,
        quantity: orderData.quantity
      };

      // Only add optional fields if they exist
      if (orderData.positionSide) {
        orderParams.positionSide = orderData.positionSide;
      }
      if (orderData.price && orderData.type !== 'MARKET') {
        orderParams.price = orderData.price;
      }
      if (orderData.stopPrice) {
        orderParams.stopPrice = orderData.stopPrice;
      }

      logger.info('Placing order with params:', orderParams);

      const response = await this.axios({
        method: 'post',
        url: '/openApi/swap/v2/trade/order',
        data: orderParams
      });
      
      logger.info('BingX API response details:', {
        status: response.status,
        statusText: response.statusText,
        data: response.data
      });
      
      return response.data;
      },
      { 
        priority: RequestPriority.CRITICAL,
        maxRetries: 3
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

  async getPositions(symbol?: string) {
    const cacheKey = `positions:${symbol || 'all'}`;
    
    return productionBingXRateLimiter.executeAccountRequest(
      cacheKey,
      async () => {
        const params: any = {};
        if (symbol) {
          params.symbol = symbol;
        }
        const response = await this.axios.get('/openApi/swap/v2/user/positions', { params });
        return response.data;
      },
      { cacheSeconds: 10, priority: RequestPriority.HIGH }
    );
  }

  async getOpenOrders(symbol?: string) {
    const cacheKey = `open_orders:${symbol || 'all'}`;
    
    return productionBingXRateLimiter.executeAccountRequest(
      cacheKey,
      async () => {
        const params: any = {};
        if (symbol) {
          params.symbol = symbol;
        }
        const response = await this.axios.get('/openApi/swap/v2/trade/openOrders', { params });
        return response.data;
      },
      { cacheSeconds: 5, priority: RequestPriority.MEDIUM }
    );
  }

  async getBalance() {
    const cacheKey = 'balance';
    
    return productionBingXRateLimiter.executeAccountRequest(
      cacheKey,
      async () => {
        const response = await this.axios.get('/openApi/swap/v2/user/balance');
        return response.data;
      },
      { cacheSeconds: 30, priority: RequestPriority.HIGH }
    );
  }

  // Listen Key for WebSocket
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
        const response = await this.axios.put('/openApi/user/auth/userDataStream', {
          listenKey
        });
        return response.data;
      },
      { 
        priority: RequestPriority.HIGH
      }
    );
  }

  async closeListenKey(listenKey: string, bypassRateLimit: boolean = false) {
    if (bypassRateLimit) {
      // Direct API call for cleanup during shutdown - avoid rate limiter
      try {
        const response = await this.axios.delete('/openApi/user/auth/userDataStream', {
          params: { listenKey },
          timeout: 5000 // Short timeout for cleanup
        });
        return response.data;
      } catch (error: any) {
        // Log but don't throw - cleanup should be non-blocking
        logger.warn('Direct listen key cleanup failed (bypassed rate limiter):', error.message);
        return null;
      }
    }

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

  // Close Position
  async closePosition(symbol: string, percentage: number = 100) {
    try {
      // Normalize symbol format: LINK-USDT -> LINKUSDT for BingX API
      const normalizedSymbol = this.normalizeSymbol(symbol);
      
      // Get current position to determine side and quantity
      const positions = await this.getPositions();
      if (positions.code !== 0 || !positions.data) {
        throw new Error('Failed to get current positions');
      }

      // Debug: Log all positions for troubleshooting
      logger.debug(`All BingX positions for close validation:`, {
        originalSymbol: symbol,
        normalizedSymbol: normalizedSymbol,
        totalPositions: positions.data.length,
        positions: positions.data.map((pos: any) => ({
          symbol: pos.symbol,
          positionAmt: pos.positionAmt,
          unrealizedProfit: pos.unrealizedProfit
        }))
      });

      // Try to find position with both original and normalized symbol
      let position = positions.data.find((pos: any) => pos.symbol === symbol);
      if (!position) {
        position = positions.data.find((pos: any) => pos.symbol === normalizedSymbol);
      }
      
      if (!position || parseFloat(position.positionAmt) === 0) {
        logger.warn(`Position not found in BingX API for close:`, {
          requestedSymbol: symbol,
          normalizedSymbol: normalizedSymbol,
          positionFound: !!position,
          positionAmount: position?.positionAmt || 'N/A',
          availableSymbols: positions.data.map((pos: any) => pos.symbol)
        });
        throw new Error(`No active position found for ${symbol} (also tried ${normalizedSymbol})`);
      }

      const positionAmt = parseFloat(position.positionAmt);
      // In BingX, positionSide tells us the direction, not the sign of positionAmt
      const isLong = position.positionSide === 'LONG';
      const currentSize = Math.abs(positionAmt);
      
      // Calculate quantity to close based on percentage
      const closeQuantity = (currentSize * percentage) / 100;
      
      logger.debug(`Position analysis for close:`, {
        originalSymbol: symbol,
        apiSymbol: position.symbol,
        positionSide: position.positionSide,
        positionAmt: position.positionAmt,
        isLong: isLong,
        currentSize: currentSize,
        closeQuantity: closeQuantity
      });

      // Use BingX specific close position endpoint instead of market order
      const closeData = {
        symbol: position.symbol, // Use actual symbol format from BingX API
        positionSide: position.positionSide, // Use the actual positionSide from API
        quantity: parseFloat(closeQuantity.toFixed(6))
      };

      logger.info(`Closing ${percentage}% of ${symbol} position:`, {
        requestedSymbol: symbol,
        actualSymbol: position.symbol,
        currentSize,
        closeQuantity: closeData.quantity,
        positionSide: closeData.positionSide
      });

      // Use existing placeOrder method which has proper formatting
      const orderData = {
        symbol: closeData.symbol,
        side: closeData.positionSide === 'LONG' ? 'SELL' : 'BUY' as 'BUY' | 'SELL',
        positionSide: closeData.positionSide,
        type: 'MARKET' as const,
        quantity: closeData.quantity
      };
      
      const response = await this.placeOrder(orderData);
      
      if (response.code === 0) {
        logger.info(`Position close order placed successfully: ${response.data?.orderId}`);
      } else {
        throw new Error(`Failed to place close order: ${response.msg}`);
      }
      
      return response;
    } catch (error) {
      logger.error(`Failed to close position ${symbol}:`, error);
      throw error;
    }
  }


  // Normalize symbol format for BingX API compatibility
  private normalizeSymbol(symbol: string): string {
    // Convert LINK-USDT to LINKUSDT (remove hyphens)
    return symbol.replace(/-/g, '');
  }

  // Rate Limit Status
  getRateLimitStatus() {
    return productionBingXRateLimiter.getStatus();
  }
  
  // Clear rate limiter cache
  clearCache() {
    productionBingXRateLimiter.restart();
    logger.info('BingX client cache cleared and production rate limiter restarted');
  }
}

export const bingxClient = new BingXClient();