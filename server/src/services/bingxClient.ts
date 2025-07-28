import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger, logToExternal } from '../utils/logger';
import { globalRateLimiter, RateLimiter, RequestCategory } from './rateLimiter';
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
const SYMBOL_CACHE_DURATION = 120000; // 2 minutes for symbols data (reduced for faster refresh)

interface BingXConfig {
  apiKey: string;
  secretKey: string;
  baseURL: string;
  demoMode: boolean;
}

export class BingXClient {
  private axios: AxiosInstance;
  private config: BingXConfig;

  /**
   * 🚀 ULTRA-FAST: Determine request category from URL for intelligent rate limiting
   */
  private getRequestCategory(url: string): RequestCategory {
    if (!url) return RequestCategory.MARKET_DATA;
    
    // Market data endpoints (highest volume, fastest limits)
    if (url.includes('/quote/') || 
        url.includes('/klines') || 
        url.includes('/depth') || 
        url.includes('/ticker') ||
        url.includes('/aggTrades') ||
        url.includes('/24hr')) {
      return RequestCategory.MARKET_DATA;
    }
    
    // Symbol/contract information
    if (url.includes('/symbols') || 
        url.includes('/contracts') || 
        url.includes('/exchangeInfo')) {
      return RequestCategory.SYMBOLS;
    }
    
    // Trading operations (orders, positions)
    if (url.includes('/order') || 
        url.includes('/position') || 
        url.includes('/trade') ||
        url.includes('/leverage') ||
        url.includes('/marginType')) {
      return RequestCategory.TRADING;
    }
    
    // Account information (balance, etc)
    if (url.includes('/account') || 
        url.includes('/balance') || 
        url.includes('/income') ||
        url.includes('/commissionRate')) {
      return RequestCategory.ACCOUNT;
    }
    
    // Default to market data for unknown endpoints
    return RequestCategory.MARKET_DATA;
  }

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
        // 🚀 ULTRA-FAST: Apply categorized rate limiting
        const category = this.getRequestCategory(config.url || '');
        await globalRateLimiter.waitForSlot(category);
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

  // Exponential backoff retry for rate limiting
  private async makeRequestWithRetry(endpoint: string, config: any, maxRetries: number = 3): Promise<any> {
    let lastError: any;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Add delay before retry (exponential backoff)
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Cap at 10s
          logger.debug(`⏳ Rate limited, waiting ${delay}ms before retry ${attempt}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        const response = await this.axios.get(endpoint, config);
        
        // Success - log if this was a retry
        if (attempt > 0) {
          logger.info(`✅ Retry successful on attempt ${attempt + 1} for ${endpoint}`);
          await logToExternal('info', 'Rate limit retry successful', {
            endpoint,
            attempt: attempt + 1,
            totalAttempts: maxRetries
          });
        }
        
        return response;
        
      } catch (error: any) {
        lastError = error;
        
        // If it's a 429 (rate limit), retry
        if (error.response?.status === 429) {
          logger.warn(`⚠️ Rate limited on ${endpoint}, attempt ${attempt + 1}/${maxRetries}`);
          
          // Check if we have retry-after header
          const retryAfter = error.response.headers['retry-after'];
          if (retryAfter && attempt < maxRetries - 1) {
            const waitTime = parseInt(retryAfter) * 1000; // Convert to ms
            logger.info(`📡 Server requested ${retryAfter}s wait, honoring it...`);
            await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 30000))); // Cap at 30s
          }
          
          continue; // Try again
        }
        
        // For non-rate-limit errors, don't retry
        throw error;
      }
    }
    
    // All retries failed
    await logToExternal('error', 'All rate limit retries failed', {
      endpoint,
      maxRetries,
      finalError: lastError.message,
      status: lastError.response?.status
    });
    
    throw lastError;
  }

  // OPTIMIZED: Parallel API calls for maximum performance
  async getSymbolsAndTickersParallel() {
    const cacheKey = 'symbols_and_tickers_parallel';
    const now = Date.now();
    
    // Check cache first
    if (symbolCache.has(cacheKey)) {
      const cached = symbolCache.get(cacheKey)!;
      if (now - cached.timestamp < SYMBOL_CACHE_DURATION) {
        logger.debug('Returning cached parallel symbols+tickers data');
        return cached.data;
      }
    }
    
    logger.info('🚀 PARALLEL FETCH: Getting symbols and tickers simultaneously...');
    
    try {
      // Execute both API calls in parallel for maximum speed
      const [symbolsResult, tickersResult] = await Promise.all([
        this.getSymbols(),
        this.getAllTickers()
      ]);
      
      const result = {
        symbols: symbolsResult,
        tickers: tickersResult,
        timestamp: now,
        source: 'parallel_fetch'
      };
      
      // Cache the combined result
      symbolCache.set(cacheKey, { timestamp: now, data: result });
      
      logger.info(`✅ PARALLEL FETCH COMPLETED: ${symbolsResult?.data?.length || 0} symbols + ${tickersResult?.data?.length || 0} tickers`);
      
      return result;
      
    } catch (error) {
      logger.error('❌ PARALLEL FETCH FAILED:', error);
      throw error;
    }
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
            
            // Add base delay to prevent rate limiting in production
            if (process.env.NODE_ENV === 'production') {
              await new Promise(resolve => setTimeout(resolve, 200)); // 200ms between requests
            }
            
            // Implement exponential backoff for rate limiting
            const response = await this.makeRequestWithRetry(endpoint, { params }, 3);
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
      
      const finalData = {
        code: 0,
        data: finalContracts,
        msg: 'exhaustive_search_complete',
        total: finalContracts.length,
        metadata: {
          endpointsTested: totalEndpointsTested,
          successfulEndpoints,
          searchType: 'exhaustive',
          timestamp: now
        }
      };
      
      // Cache por mais tempo já que foi uma busca exaustiva
      symbolCache.set(cacheKey, {
        timestamp: now,
        data: finalData
      });
      
      return finalData;
      
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

  // Method to invalidate symbols cache for forced refresh
  invalidateSymbolsCache() {
    symbolCache.clear();
    logger.debug('Symbols cache invalidated');
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

  async getAllTickers() {
    const cacheKey = 'all_tickers';
    const now = Date.now();
    const TICKERS_CACHE_DURATION = 30000; // 30 seconds cache for market data
    
    // Check cache first
    if (symbolCache.has(cacheKey)) {
      const cached = symbolCache.get(cacheKey)!;
      if (now - cached.timestamp < TICKERS_CACHE_DURATION) {
        logger.debug('Returning cached tickers data');
        return cached.data;
      }
    }
    
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
          
          const response = await this.makeRequestWithRetry(endpoint, {}, 3);
          
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
      
      // Cache the tickers data
      symbolCache.set(cacheKey, {
        timestamp: now,
        data: response
      });
      
      logger.info(`🎉 All tickers fetched successfully: ${allTickers.length} symbols from ${successfulEndpoint}`);
      
      return response;
      
    } catch (error) {
      logger.error('Failed to get all tickers:', error);
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
      
      // Log detalhado da resposta completa
      logger.info('BingX API response details:', {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: response.data,
        fullDataStructure: JSON.stringify(response.data, null, 2)
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
    return globalRateLimiter.getStatus();
  }
}

export const bingxClient = new BingXClient();