import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { globalRateLimiter, RateLimiter } from './rateLimiter';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Create a specific rate limiter for kline data  
const klineRateLimiter = new RateLimiter(5, 900); // 5 requests per 900ms (same as global)

// Enhanced cache for kline data with better rate limiting
const klineCache = new Map<string, { timestamp: number; data: any }>();
const KLINE_CACHE_DURATION = 90000; // 90 seconds - increased from 30s to reduce API pressure

// Additional cache for balance and other frequently accessed data
const balanceCache = new Map<string, { timestamp: number; data: any }>();
const BALANCE_CACHE_DURATION = 60000; // 60 seconds for balance data

const symbolCache = new Map<string, { timestamp: number; data: any }>();
const SYMBOL_CACHE_DURATION = 300000; // 5 minutes for symbols data

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
      timeout: 15000, // Increased from 10s to 15s to handle rate limiting delays
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

  // Market Data Methods (Public)
  async getSymbols() {
    const cacheKey = 'symbols';
    const now = Date.now();
    
    // Check cache first
    if (symbolCache.has(cacheKey)) {
      const cached = symbolCache.get(cacheKey)!;
      if (now - cached.timestamp < SYMBOL_CACHE_DURATION) {
        logger.debug('Returning cached symbols data');
        return cached.data;
      }
    }
    
    try {
      const response = await this.axios.get('/openApi/swap/v2/quote/contracts');
      
      // Cache the response
      symbolCache.set(cacheKey, {
        timestamp: now,
        data: response.data
      });
      
      return response.data;
    } catch (error) {
      logger.error('Failed to get symbols:', error);
      throw error;
    }
  }

  async getTicker(symbol: string) {
    try {
      // Demo mode uses same symbol format as live mode
      const apiSymbol = symbol;
      
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
      // Demo mode uses same symbol format as live mode
      const apiSymbol = symbol;
      
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
      // Demo mode uses same symbol format as live mode
      const apiSymbol = symbol;
      
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
      // Demo mode - filter out unnecessary fields for BingX
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
      return response.data;
    } catch (error) {
      logger.error('Failed to place order:', {
        error: error instanceof Error ? error.message : error,
        orderData,
        response: (error as any)?.response?.data
      });
      throw error;
    }
  }

  async cancelOrder(symbol: string, orderId: string) {
    try {
      // Demo mode uses same symbol format as live mode

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
        params.symbol = symbol; // Demo mode uses same symbol format
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
        params.symbol = symbol; // Demo mode uses same symbol format
      }

      const response = await this.axios.get('/openApi/swap/v2/trade/openOrders', { params });
      return response.data;
    } catch (error) {
      logger.error('Failed to get open orders:', error);
      throw error;
    }
  }

  async getBalance() {
    const cacheKey = 'balance';
    const now = Date.now();
    
    // Check cache first
    if (balanceCache.has(cacheKey)) {
      const cached = balanceCache.get(cacheKey)!;
      if (now - cached.timestamp < BALANCE_CACHE_DURATION) {
        logger.debug('Returning cached balance data');
        return cached.data;
      }
    }
    
    try {
      const response = await this.axios.get('/openApi/swap/v2/user/balance');
      
      // Cache the response
      balanceCache.set(cacheKey, {
        timestamp: now,
        data: response.data
      });
      
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
      const isLong = positionAmt > 0;
      const currentSize = Math.abs(positionAmt);
      
      // Calculate quantity to close based on percentage
      const closeQuantity = (currentSize * percentage) / 100;

      // Create opposite order to close the position (use the symbol format from the actual position)
      const orderData = {
        symbol: position.symbol, // Use actual symbol format from BingX API
        side: isLong ? 'SELL' : 'BUY' as 'BUY' | 'SELL',
        positionSide: isLong ? 'LONG' : 'SHORT' as 'LONG' | 'SHORT',
        type: 'MARKET' as const,
        quantity: parseFloat(closeQuantity.toFixed(6))
      };

      logger.info(`Closing ${percentage}% of ${symbol} position:`, {
        requestedSymbol: symbol,
        actualSymbol: position.symbol,
        currentSize,
        closeQuantity: orderData.quantity,
        side: orderData.side,
        positionSide: orderData.positionSide
      });

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
    return globalRateLimiter.getStatus();
  }
}

export const bingxClient = new BingXClient();