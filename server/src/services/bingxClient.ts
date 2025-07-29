import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger, logToExternal } from '../utils/logger';
import { bingxRateLimiter } from './bingxRateLimiter';
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
          
          await bingxRateLimiter.handleRateLimit(error, originalRequest._retryCount || 1);
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
    
    // Use rate limiter's batch execution for controlled parallelism
    const results = await bingxRateLimiter.executeBatchMarketDataRequests([
      {
        key: 'symbols',
        requestFn: () => this.fetchSymbolsFromAPI() as Promise<any>,
        cacheSeconds: 60
      },
      {
        key: 'all_tickers', 
        requestFn: () => this.fetchTickersFromAPI() as Promise<any>,
        cacheSeconds: 30
      }
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
    
    return bingxRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => this.fetchSymbolsFromAPI(),
      60 // Cache for 1 minute (faster refresh)
    );
  }
  
  private async fetchSymbolsFromAPI() {
    
    try {
      logger.info('🔥 BUSCA EXAUSTIVA: Vasculhando TODOS os endpoints BingX...');
      
      const allFoundContracts = new Map<string, any>(); // Usar Map para evitar duplicatas
      let totalEndpointsTested = 0;
      let successfulEndpoints = 0;
      
      // TODOS OS ENDPOINTS POSSÍVEIS DA BINGX
      const ALL_POSSIBLE_ENDPOINTS = [
        // Contratos Perpétuos (Swap)
        '/openApi/swap/v1/quote/contracts',
        '/openApi/swap/v2/quote/contracts', 
        '/openApi/swap/v3/quote/contracts',
        '/openApi/swap/v1/market/contracts',
        '/openApi/swap/v2/market/contracts',
        '/openApi/swap/v3/market/contracts',
        
        // Tickers e Preços
        '/openApi/swap/v1/quote/tickers',
        '/openApi/swap/v2/quote/tickers',
        '/openApi/swap/v3/quote/tickers',
        '/openApi/swap/v1/ticker/price',
        '/openApi/swap/v2/ticker/price',
        '/openApi/swap/v1/ticker/24hr',
        '/openApi/swap/v2/ticker/24hr',
        
        // Exchange Info
        '/openApi/swap/v1/exchangeInfo',
        '/openApi/swap/v2/exchangeInfo',
        '/openApi/swap/v3/exchangeInfo',
        
        // Símbolos e Mercados
        '/openApi/swap/v1/symbols',
        '/openApi/swap/v2/symbols',
        '/openApi/swap/v1/market/symbols',
        '/openApi/swap/v2/market/symbols',
        
        // Informações de Trading
        '/openApi/swap/v1/quote/bookTicker',
        '/openApi/swap/v2/quote/bookTicker',
        '/openApi/swap/v1/quote/ticker',
        '/openApi/swap/v2/quote/ticker',
        
        // Spot (caso tenham contratos spot)
        '/openApi/spot/v1/symbols',
        '/openApi/spot/v2/symbols',
        '/openApi/spot/v1/ticker/24hr',
        '/openApi/spot/v2/ticker/24hr',
        
        // Futuros Delivery
        '/openApi/future/v1/symbols',
        '/openApi/future/v2/symbols',
        '/openApi/future/v1/contracts',
        '/openApi/future/v2/contracts',
        
        // API Pública Geral
        '/api/v1/exchangeInfo',
        '/api/v2/exchangeInfo', 
        '/api/v3/exchangeInfo',
        '/api/v1/ticker/24hr',
        '/api/v2/ticker/24hr',
        '/api/v3/ticker/24hr'
      ];
      
      logger.info(`🎯 Testando ${ALL_POSSIBLE_ENDPOINTS.length} endpoints diferentes...`);
      
      // Testar TODOS os endpoints com TODAS as combinações de parâmetros
      for (const endpoint of ALL_POSSIBLE_ENDPOINTS) {
        totalEndpointsTested++;
        
        // Diferentes combinações de parâmetros para cada endpoint
        const paramCombinations = [
          {}, // Sem parâmetros
          { limit: 1000 },
          { limit: 5000 },
          { size: 1000 },
          { size: 5000 },
          { page: 1, limit: 1000 },
          { page: 1, size: 1000 },
          { offset: 0, limit: 1000 },
          { start: 0, limit: 1000 },
          { from: 0, to: 1000 }
        ];
        
        for (const params of paramCombinations) {
          try {
            logger.debug(`🔍 Testando: ${endpoint} com params:`, params);
            
            const response = await this.axios.get(endpoint, { params });
            const contracts = this.extractContractsFromResponse(response.data);
            
            if (contracts.length > 0) {
              successfulEndpoints++;
              logger.info(`✅ SUCESSO: ${endpoint} retornou ${contracts.length} contratos`, {
                params,
                sampleContract: contracts[0]?.symbol || 'N/A',
                responseStructure: Object.keys(response.data || {})
              });
              
              // Adicionar todos os contratos únicos ao Map
              contracts.forEach((contract: any) => {
                if (contract.symbol && !allFoundContracts.has(contract.symbol)) {
                  allFoundContracts.set(contract.symbol, {
                    ...contract,
                    _source_endpoint: endpoint,
                    _source_params: params
                  });
                }
              });
              
              break; // Se funcionou com estes params, não testar outros para este endpoint
            }
            
          } catch (error: any) {
            logger.debug(`❌ Falhou: ${endpoint} - ${error.message}`);
            
            // Log critical failures to external service for production debugging
            if (process.env.NODE_ENV === 'production' && (error.code === 'ECONNABORTED' || error.response?.status >= 400)) {
              await logToExternal('debug', `BingX endpoint failed: ${endpoint}`, {
                error: error.message,
                code: error.code,
                status: error.response?.status,
                timeout: error.code === 'ECONNABORTED',
                params: params
              });
            }
          }
        }
      }
      
      const uniqueContracts = Array.from(allFoundContracts.values());
      
      logger.info(`🏆 RESULTADO FINAL DA BUSCA EXAUSTIVA:`, {
        totalEndpointsTested,
        successfulEndpoints,
        totalUniqueContracts: uniqueContracts.length,
        contractsBySource: this.groupContractsBySource(uniqueContracts)
      });

      // Enhanced logging for production debugging
      if (process.env.NODE_ENV === 'production') {
        await logToExternal('info', 'BingX exhaustive search completed', {
          totalEndpointsTested,
          successfulEndpoints,
          totalUniqueContracts: uniqueContracts.length,
          environment: 'render',
          issue: uniqueContracts.length === 0 ? 'ALL_ENDPOINTS_RETURNED_ZERO_CONTRACTS' : null
        });
      }
      
      // Se ainda não encontramos muitos contratos, tentar paginação nos endpoints que funcionaram
      if (uniqueContracts.length < 1000) {
        logger.info('🔄 Tentando PAGINAÇÃO EXAUSTIVA nos endpoints que funcionaram...');
        await this.tryExhaustivePagination(allFoundContracts);
      }
      
      const finalContracts = Array.from(allFoundContracts.values());
      
      logger.info(`🎉 BUSCA COMPLETA FINALIZADA: ${finalContracts.length} contratos únicos encontrados`);
      
      return {
        code: 0,
        data: finalContracts,
        msg: 'exhaustive_search_complete',
        total: finalContracts.length,
        metadata: {
          endpointsTested: totalEndpointsTested,
          successfulEndpoints,
          searchType: 'exhaustive',
          timestamp: Date.now()
        }
      };
      
    } catch (error) {
      logger.error('Failed exhaustive search:', error);
      throw error;
    }
  }
  
  // Método auxiliar para extrair contratos de diferentes formatos de resposta
  private extractContractsFromResponse(data: any): any[] {
    if (!data) return [];
    
    // Tentar diferentes estruturas de resposta
    const possiblePaths = [
      data.data,           // { data: [...] }
      data.symbols,        // { symbols: [...] }
      data.result,         // { result: [...] }
      data.contracts,      // { contracts: [...] }
      data.tickers,        // { tickers: [...] }
      data,                // Direto como array
    ];
    
    for (const path of possiblePaths) {
      if (Array.isArray(path) && path.length > 0) {
        // Verificar se parece com contratos (tem símbolo)
        if (path[0]?.symbol || path[0]?.contractName || path[0]?.pair) {
          return path;
        }
      }
    }
    
    return [];
  }
  
  // Método auxiliar para agrupar contratos por fonte
  private groupContractsBySource(contracts: any[]): Record<string, number> {
    const groups: Record<string, number> = {};
    contracts.forEach(contract => {
      const source = contract._source_endpoint || 'unknown';
      groups[source] = (groups[source] || 0) + 1;
    });
    return groups;
  }
  
  // Método para tentar paginação exaustiva
  private async tryExhaustivePagination(contractsMap: Map<string, any>): Promise<void> {
    // Implementar paginação nos endpoints que mostraram ter mais dados
    const paginationEndpoints = [
      '/openApi/swap/v2/quote/contracts',
      '/openApi/swap/v2/quote/tickers',
      '/openApi/swap/v1/quote/contracts'
    ];
    
    for (const endpoint of paginationEndpoints) {
      for (let page = 1; page <= 50; page++) { // Até 50 páginas
        try {
          const params = { page, limit: 1000 };
          const response = await this.axios.get(endpoint, { params });
          const contracts = this.extractContractsFromResponse(response.data);
          
          if (contracts.length === 0) break; // Não há mais páginas
          
          let newContracts = 0;
          contracts.forEach((contract: any) => {
            if (contract.symbol && !contractsMap.has(contract.symbol)) {
              contractsMap.set(contract.symbol, {
                ...contract,
                _source_endpoint: endpoint,
                _source_params: params
              });
              newContracts++;
            }
          });
          
          logger.info(`📄 ${endpoint} página ${page}: +${newContracts} novos contratos`);
          
          if (newContracts === 0) break; // Todos já eram conhecidos
          
        } catch (error) {
          break; // Erro na paginação, tentar próximo endpoint
        }
      }
    }
  }


  async getTicker(symbol: string) {
    const cacheKey = `ticker:${symbol}`;
    
    return bingxRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => {
        const apiSymbol = symbol;
        const response = await this.axios.get('/openApi/swap/v2/quote/ticker', {
          params: { symbol: apiSymbol }
        });
        return response.data;
      },
      30 // Cache for 30 seconds
    );
  }

  async getAllTickers() {
    const cacheKey = 'all_tickers';
    
    return bingxRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => this.fetchTickersFromAPI(),
      30 // Cache for 30 seconds
    );
  }
  
  private async fetchTickersFromAPI() {
    
    try {
      logger.info('🎯 Fetching ALL market data from BingX...');
      
      // Try different endpoints for getting all tickers
      const tickerEndpoints = [
        '/openApi/swap/v2/quote/ticker',    // All tickers without symbol param
        '/openApi/swap/v1/quote/ticker',    // v1 fallback
        '/openApi/swap/v2/ticker/24hr',     // 24hr stats
        '/openApi/swap/v1/ticker/24hr',     // v1 24hr stats
        '/openApi/swap/v2/quote/tickers',   // Plural form
        '/openApi/swap/v1/quote/tickers'    // v1 plural
      ];
      
      let allTickers: any[] = [];
      let successfulEndpoint = '';
      
      for (const endpoint of tickerEndpoints) {
        try {
          logger.debug(`🔍 Trying ticker endpoint: ${endpoint}`);
          
          const response = await this.axios.get(endpoint);
          
          if (response.data && response.data.code === 0) {
            const tickers = response.data.data;
            
            if (Array.isArray(tickers) && tickers.length > 0) {
              allTickers = tickers;
              successfulEndpoint = endpoint;
              logger.info(`✅ Successfully fetched ${tickers.length} tickers from ${endpoint}`);
              break;
            }
          }
          
        } catch (error: any) {
          logger.debug(`❌ Failed to fetch from ${endpoint}: ${error.message}`);
          // Log to external service for production debugging
          await logToExternal('error', `BingX ticker endpoint failed: ${endpoint}`, {
            error: error.message,
            code: error.code,
            status: error.response?.status,
            timeout: error.code === 'ECONNABORTED'
          });
          continue;
        }
      }
      
      if (allTickers.length === 0) {
        throw new Error('No ticker endpoints returned valid market data');
      }
      
      const response = {
        code: 0,
        data: allTickers,
        msg: 'success',
        endpoint: successfulEndpoint,
        count: allTickers.length
      };
      
      logger.info(`🎉 All tickers fetched successfully: ${allTickers.length} symbols from ${successfulEndpoint}`);
      
      return response;
      
    } catch (error) {
      logger.error('Failed to get all tickers:', error);
      throw error;
    }
  }

  async getKlines(symbol: string, interval: string, limit: number = 500) {
    const cacheKey = `klines:${symbol}:${interval}:${limit}`;
    
    return bingxRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => {
        const apiSymbol = symbol;
        const response = await this.axios.get('/openApi/swap/v2/quote/klines', {
          params: { symbol: apiSymbol, interval, limit }
        });
        return response.data;
      },
      30 // Cache for 30 seconds (faster updates)
    );
  }

  async getDepth(symbol: string, limit: number = 20) {
    const cacheKey = `depth:${symbol}:${limit}`;
    
    return bingxRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => {
        const apiSymbol = symbol;
        const response = await this.axios.get('/openApi/swap/v2/quote/depth', {
          params: { symbol: apiSymbol, limit }
        });
        return response.data;
      },
      5 // Cache for 5 seconds
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
    return bingxRateLimiter.executeTradingRequest(async () => {
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
    });
  }

  async cancelOrder(symbol: string, orderId: string) {
    return bingxRateLimiter.executeTradingRequest(async () => {
      const response = await this.axios.delete('/openApi/swap/v2/trade/order', {
        params: { symbol, orderId }
      });
      return response.data;
    });
  }

  async getPositions(symbol?: string) {
    const cacheKey = `positions:${symbol || 'all'}`;
    
    return bingxRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => {
        const params: any = {};
        if (symbol) {
          params.symbol = symbol;
        }
        const response = await this.axios.get('/openApi/swap/v2/user/positions', { params });
        return response.data;
      },
      10 // Cache for 10 seconds
    );
  }

  async getOpenOrders(symbol?: string) {
    const cacheKey = `open_orders:${symbol || 'all'}`;
    
    return bingxRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => {
        const params: any = {};
        if (symbol) {
          params.symbol = symbol;
        }
        const response = await this.axios.get('/openApi/swap/v2/trade/openOrders', { params });
        return response.data;
      },
      5 // Cache for 5 seconds
    );
  }

  async getBalance() {
    const cacheKey = 'balance';
    
    return bingxRateLimiter.executeMarketDataRequest(
      cacheKey,
      async () => {
        const response = await this.axios.get('/openApi/swap/v2/user/balance');
        return response.data;
      },
      30 // Cache for 30 seconds (faster balance updates)
    );
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
    return bingxRateLimiter.getStatus();
  }
  
  // Clear rate limiter cache
  clearCache() {
    bingxRateLimiter.clearCache();
    // Also restart limiters in case they were stopped
    bingxRateLimiter.restartLimiters();
    logger.info('BingX client cache cleared and limiters restarted');
  }
}

export const bingxClient = new BingXClient();