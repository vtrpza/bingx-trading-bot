import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { globalRateLimiter, RateLimiter } from './rateLimiter';

// Create a specific rate limiter for kline data
const klineRateLimiter = new RateLimiter(5, 900000); // 5 requests per 15 minutes

// Cache for kline data
const klineCache = new Map<string, { timestamp: number; data: any }>();
const KLINE_CACHE_DURATION = 60000; // 1 minute

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
    this.config = {
      apiKey: process.env.BINGX_API_KEY || '',
      secretKey: process.env.BINGX_SECRET_KEY || '',
      baseURL: process.env.BINGX_API_URL || 'https://open-api.bingx.com',
      demoMode: process.env.DEMO_MODE === 'true'
    };

    // Debug API key loading
    logger.info('BingX Client initialized', {
      hasApiKey: !!this.config.apiKey,
      hasSecretKey: !!this.config.secretKey,
      demoMode: this.config.demoMode,
      apiKeyLength: this.config.apiKey ? this.config.apiKey.length : 0
    });

    this.axios = axios.create({
      baseURL: this.config.baseURL,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor for rate limiting and authentication
    this.axios.interceptors.request.use(
      async (config) => {
        // Apply global rate limiting for all requests
        await globalRateLimiter.waitForSlot();
        return this.addAuthentication(config);
      },
      (error) => Promise.reject(error)
    );

    // Add response interceptor for error handling with retry logic
    this.axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;
        
        // Handle BingX rate limiting error 109400
        if (error.response?.data?.code === 109400 && !originalRequest._retried) {
          originalRequest._retried = true;
          
          logger.warn('BingX rate limit exceeded (109400), implementing backoff and retry', {
            url: originalRequest.url,
            retryAfter: error.response.data.retryAfter || 'unknown',
            message: error.response.data.msg || 'Rate limit exceeded'
          });
          
          // Parse retry time from error message if available
          const errorMsg = error.response.data.msg || '';
          const retryTimeMatch = errorMsg.match(/retry after time: (\d+)/);
          let retryAfter = 3000; // Default 3 seconds
          
          if (retryTimeMatch) {
            const retryTimestamp = parseInt(retryTimeMatch[1]);
            const currentTime = Date.now();
            retryAfter = Math.max(1000, retryTimestamp - currentTime); // At least 1 second
            logger.info(`BingX specified retry time: ${new Date(retryTimestamp).toISOString()}, waiting ${retryAfter}ms`);
          }
          
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          
          // Reset rate limiter to prevent immediate subsequent failures
          globalRateLimiter.reset();
          
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

    if (!config.params) {
      config.params = {};
    }

    // Add timestamp
    const timestamp = Date.now();

    // Create signature string following BingX official method
    let parameters = '';
    
    // Add existing parameters first (maintain original order, not sorted)
    for (const key in config.params) {
      if (key !== 'timestamp' && key !== 'signature') {
        parameters += key + '=' + encodeURIComponent(config.params[key]) + '&';
      }
    }
    
    // Remove trailing & if parameters exist, then add timestamp
    if (parameters) {
      parameters = parameters.substring(0, parameters.length - 1);
      parameters = parameters + '&timestamp=' + timestamp;
    } else {
      parameters = 'timestamp=' + timestamp;
    }

    // Generate signature using the correct BingX method
    const signature = crypto
      .createHmac('sha256', this.config.secretKey)
      .update(parameters)
      .digest('hex');

    // Add timestamp and signature to params
    config.params.timestamp = timestamp;
    config.params.signature = signature;
    config.headers['X-BX-APIKEY'] = this.config.apiKey;

    // Log signature details for debugging
    logger.debug('BingX Authentication Debug:', {
      parameters,
      signature,
      timestamp
    });

    return config;
  }

  // Market Data Methods (Public)
  async getSymbols() {
    try {
      const response = await this.axios.get('/openApi/swap/v2/quote/contracts');
      return response.data;
    } catch (error) {
      logger.error('Failed to get symbols:', error);
      throw error;
    }
  }

  async getTicker(symbol: string) {
    try {
      // For demo mode, convert symbol to VST
      const apiSymbol = this.config.demoMode ? symbol.replace('-USDT', '-VST') : symbol;
      
      const response = await this.axios.get('/openApi/swap/v2/quote/ticker', {
        params: { symbol: apiSymbol }
      });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get ticker for ${symbol}:`, error);
      throw error;
    }
  }

  async getKlines(symbol: string, interval: string, limit: number = 500) {
    const cacheKey = `${symbol}:${interval}:${limit}`;
    const cached = klineCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < KLINE_CACHE_DURATION) {
      logger.debug(`Returning cached kline data for ${symbol}`);
      return cached.data;
    }

    try {
      await klineRateLimiter.waitForSlot();
      // For demo mode, convert symbol to VST
      const apiSymbol = this.config.demoMode ? symbol.replace('-USDT', '-VST') : symbol;
      
      const response = await this.axios.get('/openApi/swap/v2/quote/klines', {
        params: { symbol: apiSymbol, interval, limit }
      });

      klineCache.set(cacheKey, { timestamp: Date.now(), data: response.data });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get klines for ${symbol}:`, error);
      throw error;
    }
  }

  async getDepth(symbol: string, limit: number = 20) {
    try {
      // For demo mode, convert symbol to VST
      const apiSymbol = this.config.demoMode ? symbol.replace('-USDT', '-VST') : symbol;
      
      const response = await this.axios.get('/openApi/swap/v2/quote/depth', {
        params: { symbol: apiSymbol, limit }
      });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get depth for ${symbol}:`, error);
      throw error;
    }
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
    try {
      // For demo mode, append -VST to symbol
      if (this.config.demoMode) {
        orderData.symbol = orderData.symbol.replace('-USDT', '-VST');
      }

      const response = await this.axios.post('/openApi/swap/v2/trade/order', orderData);
      return response.data;
    } catch (error) {
      logger.error('Failed to place order:', error);
      throw error;
    }
  }

  async cancelOrder(symbol: string, orderId: string) {
    try {
      if (this.config.demoMode) {
        symbol = symbol.replace('-USDT', '-VST');
      }

      const response = await this.axios.delete('/openApi/swap/v2/trade/order', {
        params: { symbol, orderId }
      });
      return response.data;
    } catch (error) {
      logger.error('Failed to cancel order:', error);
      throw error;
    }
  }

  async getPositions(symbol?: string) {
    try {
      const params: any = {};
      if (symbol) {
        params.symbol = this.config.demoMode ? symbol.replace('-USDT', '-VST') : symbol;
      }

      const response = await this.axios.get('/openApi/swap/v2/user/positions', { params });
      return response.data;
    } catch (error) {
      logger.error('Failed to get positions:', error);
      throw error;
    }
  }

  async getOpenOrders(symbol?: string) {
    try {
      const params: any = {};
      if (symbol) {
        params.symbol = this.config.demoMode ? symbol.replace('-USDT', '-VST') : symbol;
      }

      const response = await this.axios.get('/openApi/swap/v2/trade/openOrders', { params });
      return response.data;
    } catch (error) {
      logger.error('Failed to get open orders:', error);
      throw error;
    }
  }

  async getBalance() {
    try {
      const response = await this.axios.get('/openApi/swap/v2/user/balance');
      return response.data;
    } catch (error) {
      logger.error('Failed to get balance:', error);
      throw error;
    }
  }

  // Listen Key for WebSocket
  async createListenKey() {
    try {
      const response = await this.axios.post('/openApi/user/auth/userDataStream');
      return response.data;
    } catch (error) {
      logger.error('Failed to create listen key:', error);
      throw error;
    }
  }

  async keepAliveListenKey(listenKey: string) {
    try {
      const response = await this.axios.put('/openApi/user/auth/userDataStream', {
        listenKey
      });
      return response.data;
    } catch (error) {
      logger.error('Failed to keep alive listen key:', error);
      throw error;
    }
  }

  async closeListenKey(listenKey: string) {
    try {
      const response = await this.axios.delete('/openApi/user/auth/userDataStream', {
        params: { listenKey }
      });
      return response.data;
    } catch (error) {
      logger.error('Failed to close listen key:', error);
      throw error;
    }
  }

  // Rate Limit Status
  getRateLimitStatus() {
    return globalRateLimiter.getStatus();
  }
}

export const bingxClient = new BingXClient();
