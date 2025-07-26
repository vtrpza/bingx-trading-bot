import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger';

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

    this.axios = axios.create({
      baseURL: this.config.baseURL,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor for authentication
    this.axios.interceptors.request.use(
      (config) => this.addAuthentication(config),
      (error) => Promise.reject(error)
    );

    // Add response interceptor for error handling
    this.axios.interceptors.response.use(
      (response) => response,
      (error) => {
        logger.error('BingX API Error:', {
          status: error.response?.status,
          data: error.response?.data,
          url: error.config?.url
        });
        return Promise.reject(error);
      }
    );
  }

  private addAuthentication(config: any) {
    if (!config.params) {
      config.params = {};
    }

    // Add timestamp
    config.params.timestamp = Date.now();

    // Sort parameters alphabetically
    const sortedParams = Object.keys(config.params)
      .sort()
      .reduce((acc: any, key) => {
        acc[key] = config.params[key];
        return acc;
      }, {});

    // Create signature string
    const signatureString = Object.entries(sortedParams)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    // Generate signature
    const signature = crypto
      .createHmac('sha256', this.config.secretKey)
      .update(signatureString)
      .digest('hex');

    config.params.signature = signature;
    config.headers['X-BX-APIKEY'] = this.config.apiKey;

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
      const response = await this.axios.get('/openApi/swap/v2/quote/ticker', {
        params: { symbol }
      });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get ticker for ${symbol}:`, error);
      throw error;
    }
  }

  async getKlines(symbol: string, interval: string, limit: number = 500) {
    try {
      const response = await this.axios.get('/openApi/swap/v2/quote/klines', {
        params: { symbol, interval, limit }
      });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get klines for ${symbol}:`, error);
      throw error;
    }
  }

  async getDepth(symbol: string, limit: number = 20) {
    try {
      const response = await this.axios.get('/openApi/swap/v2/quote/depth', {
        params: { symbol, limit }
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
}

export const bingxClient = new BingXClient();