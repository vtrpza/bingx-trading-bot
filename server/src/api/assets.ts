import { Router, Request, Response, NextFunction } from 'express';
// RENDER CRITICAL FIX: Use ProductionOptimizedBingXClient for better reliability
// This client has: intelligent endpoint selection, better caching, faster failover,
// and improved rate limiting - essential for Render's production constraints
import { productionOptimizedBingXClient as bingxClient } from '../services/ProductionOptimizedBingXClient';
import Asset from '../models/Asset';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';
import { sequelize } from '../config/database';
import CoinInfoService from '../services/coinInfoService';

const router = Router();

// RENDER SPECIFIC: Add memory monitoring middleware for all routes
router.use((req: Request, res: Response, next: NextFunction) => {
  const memory = process.memoryUsage();
  const memoryMB = Math.round(memory.heapUsed / 1024 / 1024);
  
  // Log high memory usage
  if (memoryMB > 400) {
    logger.warn(`⚠️ RENDER: High memory usage (${memoryMB}MB) for ${req.method} ${req.path}`);
  }
  
  // Add memory info to response headers for monitoring
  res.setHeader('X-Memory-Usage', `${memoryMB}MB`);
  res.setHeader('X-Platform', 'render');
  
  next();
});

// Helper function to get the correct like operator based on database dialect
const getLikeOperator = () => {
  return sequelize.getDialect() === 'postgres' ? Op.iLike : Op.like;
};

// Store active refresh sessions for progress tracking
const refreshSessions = new Map<string, Response>();

// SSE endpoint for refresh progress - RENDER.COM OPTIMIZED
router.get('/refresh/progress/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId;
  console.log(`🔌 Nova conexão SSE: ${sessionId} from ${req.headers.origin}`);
  
  // RENDER-SPECIFIC SSE HEADERS - Critical for production deployment
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // CRITICAL: Prevents nginx buffering on Render
  
  // Set CORS headers properly for SSE
  const origin = req.headers.origin;
  if (origin && (origin.includes('localhost') || origin.includes('onrender.com'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Cache-Control, Accept, Accept-Encoding');
  
  // Additional headers for better compatibility
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  // Immediately flush headers to establish connection
  res.flushHeaders();
  
  // Store session
  refreshSessions.set(sessionId, res);
  console.log(`📊 SSE sessions ativas: ${refreshSessions.size}`);
  
  // Send initial connection message with immediate flush
  const initialMessage = { type: 'connected', sessionId, timestamp: Date.now() };
  res.write(`data: ${JSON.stringify(initialMessage)}\n\n`);
  res.flush();
  console.log(`✅ Mensagem inicial SSE enviada para ${sessionId}`);
  
  // RENDER FIX: 30-second keep-alive to prevent 60-second timeout
  const heartbeat = setInterval(() => {
    if (refreshSessions.has(sessionId)) {
      // Send invisible comment line to maintain connection (Render best practice)
      res.write(':\n\n'); // SSE comment - invisible to client but keeps connection alive
      res.flush();
      
      // Every 6th heartbeat (3 minutes), send visible heartbeat
      const now = Date.now();
      if (now % 180000 < 30000) { // Roughly every 3 minutes
        const pingMessage = { 
          type: 'heartbeat', 
          sessionId, 
          timestamp: now,
          message: '💓 Conexão ativa - Render optimized' 
        };
        res.write(`data: ${JSON.stringify(pingMessage)}\n\n`);
        res.flush();
      }
    } else {
      clearInterval(heartbeat);
    }
  }, 30000); // 30 seconds - CRITICAL for Render's 60-second timeout
  
  // Enhanced cleanup for Render deployment stability
  const cleanup = () => {
    console.log(`🔚 Cliente SSE desconectado: ${sessionId}`);
    clearInterval(heartbeat);
    refreshSessions.delete(sessionId);
    
    // Properly close the response to free resources on Render
    if (!res.headersSent) {
      res.end();
    }
    console.log(`📊 SSE sessions restantes: ${refreshSessions.size}`);
  };
  
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  req.on('error', (err) => {
    console.error(`❌ Erro na conexão SSE ${sessionId}:`, err.message);
    cleanup();
  });
  
  // RENDER-SPECIFIC: Handle server-side connection timeout
  setTimeout(() => {
    if (refreshSessions.has(sessionId)) {
      console.log(`⏰ Timeout preventivo para sessão SSE ${sessionId} (55s)`);
      // Send final message before potential Render timeout
      const timeoutMessage = { 
        type: 'timeout_warning', 
        sessionId, 
        message: 'Conexão será renovada automaticamente' 
      };
      res.write(`data: ${JSON.stringify(timeoutMessage)}\n\n`);
      res.flush();
    }
  }, 55000); // 55 seconds - just before Render's 60s timeout
});

// SSE Test endpoint for debugging Render deployment
router.get('/sse-test', (req: Request, res: Response) => {
  console.log('🧪 SSE Test endpoint accessed');
  
  // Same Render-optimized headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  res.flushHeaders();
  
  // Send test messages every 2 seconds
  let counter = 0;
  const testInterval = setInterval(() => {
    counter++;
    const testMessage = {
      type: 'test',
      counter,
      timestamp: new Date().toISOString(),
      message: `Test message ${counter} - Render deployment check`
    };
    
    res.write(`data: ${JSON.stringify(testMessage)}\n\n`);
    res.flush();
    
    // Stop after 30 messages (1 minute)
    if (counter >= 30) {
      clearInterval(testInterval);
      const finalMessage = {
        type: 'test_complete',
        message: 'SSE test completed successfully on Render!'
      };
      res.write(`data: ${JSON.stringify(finalMessage)}\n\n`);
      res.flush();
      res.end();
    }
  }, 2000);
  
  // Cleanup on disconnect
  req.on('close', () => {
    console.log('🧪 SSE Test client disconnected');
    clearInterval(testInterval);
  });
  
  req.on('error', (err) => {
    console.error('🧪 SSE Test error:', err);
    clearInterval(testInterval);
  });
});

// Helper function to send progress updates - RENDER.COM OPTIMIZED
function sendProgress(sessionId: string, data: any): Promise<void> {
  return new Promise((resolve) => {
    const session = refreshSessions.get(sessionId);
    if (session) {
      try {
        const message = `data: ${JSON.stringify(data)}\n\n`;
        console.log(`📡 RENDER SSE para ${sessionId}:`, data.type, data.message?.substring(0, 50) + '...');
        
        // RENDER CRITICAL: Safe write with error handling
        session.write(message, (error) => {
          if (error) {
            logger.warn(`⚠️ RENDER SSE write error for ${sessionId}:`, error.message);
          }
        });
        
        // RENDER CRITICAL: Always flush immediately for real-time delivery
        session.flush();
        
        // Additional Render optimizations
        if (session.socket && !session.socket.destroyed) {
          session.socket.setNoDelay(true); // Disable Nagle's algorithm
        }
        
        // Yield to event loop to ensure message is sent before continuing
        setImmediate(resolve);
      } catch (sseError) {
        logger.warn(`⚠️ RENDER SSE error for ${sessionId}:`, sseError);
        resolve(); // Don't fail the operation due to SSE issues
      }
    } else {
      console.log(`⚠️ RENDER: SSE sessão ${sessionId} não encontrada (${refreshSessions.size} ativas)`);
      resolve();
    }
  });
}

// Helper function to yield control to event loop
function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// RENDER MONITORING: Add health check endpoint
router.get('/health/render', asyncHandler(async (_req: Request, res: Response) => {
  const memory = process.memoryUsage();
  const memoryMB = Math.round(memory.heapUsed / 1024 / 1024);
  const uptime = process.uptime();
  
  // Quick database connectivity test
  let dbHealth = 'unknown';
  try {
    const assetCount = await Asset.count();
    dbHealth = assetCount >= 0 ? 'healthy' : 'empty';
  } catch (dbError) {
    dbHealth = 'error';
  }
  
  const health = {
    status: 'healthy',
    platform: 'render',
    memory: {
      used: `${memoryMB}MB`,
      limit: '512MB',
      usage: `${((memoryMB / 512) * 100).toFixed(1)}%`,
      healthy: memoryMB < 400
    },
    database: dbHealth,
    uptime: `${Math.floor(uptime / 60)}min ${Math.floor(uptime % 60)}s`,
    timestamp: new Date().toISOString(),
    activeSessions: refreshSessions.size
  };
  
  res.json(health);
}));

// Get all assets with pagination, sorting, and filtering
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { 
    page = 1, 
    limit = 20, 
    sortBy = 'volume24h', 
    sortOrder = 'DESC',
    search = '',
    status = 'TRADING'
  } = req.query;

  const pageNum = parseInt(page as string);
  const limitNum = parseInt(limit as string);
  const offset = (pageNum - 1) * limitNum;

  // Build where clause
  const where: any = {};
  
  if (status) {
    where.status = status;
  }
  
  if (search) {
    const likeOp = getLikeOperator();
    where[Op.or] = [
      { symbol: { [likeOp]: `%${search}%` } },
      { name: { [likeOp]: `%${search}%` } }
    ];
  }

  // Get assets from database
  const { count, rows } = await Asset.findAndCountAll({
    where,
    limit: limitNum,
    offset,
    order: [[sortBy as string, sortOrder as string]]
  });

  res.json({
    success: true,
    data: {
      assets: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum)
      }
    }
  });
}));

// Get all assets without pagination (for full data loading) - RENDER OPTIMIZED
router.get('/all', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // RENDER: Monitor memory before large data operations
  const startMem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  if (startMem > 400) {
    logger.warn(`⚠️ RENDER: High memory usage (${startMem}MB) before assets/all request`);
  }
  const { 
    sortBy = 'quoteVolume24h', 
    sortOrder = 'DESC',
    search = '',
    status = 'TRADING'
  } = req.query;

  // Build where clause
  const where: any = {};
  
  if (status) {
    where.status = status;
  }
  
  if (search) {
    const likeOp = getLikeOperator();
    where[Op.or] = [
      { symbol: { [likeOp]: `%${search}%` } },
      { name: { [likeOp]: `%${search}%` } }
    ];
  }

  const startTime = Date.now();
  
  // Get all assets from database without pagination
  const assets = await Asset.findAll({
    where,
    order: [[sortBy as string, sortOrder as string]]
  });

  const executionTime = ((Date.now() - startTime) / 1000).toFixed(3);

  // If no assets found, provide helpful message
  if (assets.length === 0) {
    logger.warn('No assets found in database - database may be empty');
    res.json({
      success: true,
      data: {
        assets: [],
        count: 0,
        executionTime: `${executionTime}s`,
        lastUpdated: new Date().toISOString(),
        message: 'No assets found. Try refreshing the asset data from the Assets page.',
        needsRefresh: true
      }
    });
    return;
  }

  res.json({
    success: true,
    data: {
      assets,
      count: assets.length,
      executionTime: `${executionTime}s`,
      lastUpdated: new Date().toISOString()
    }
  });
}));

// Symbol validation helper
function validateAndFormatSymbol(symbol: string): string {
  if (!symbol) {
    throw new AppError('Symbol is required', 400);
  }
  
  // Convert to uppercase and normalize format
  let normalizedSymbol = symbol.toUpperCase().replace(/[\/\\]/g, '-');
  
  // Fix the specific DOT-VST-USDT issue by removing incorrect VST insertion
  normalizedSymbol = normalizedSymbol.replace(/-VST-USDT$/i, '-USDT');
  normalizedSymbol = normalizedSymbol.replace(/-VST-USDC$/i, '-USDC');
  
  // Remove any duplicate VST patterns that might exist
  normalizedSymbol = normalizedSymbol.replace(/(-VST)+/gi, '');
  
  // Remove any trailing -VST-USDT, -VST-USDC patterns (additional safety)
  let cleanedSymbol = normalizedSymbol.replace(/-VST-(USDT|USDC)$/, '-$1');
  
  // Check if symbol already has proper suffix
  if (cleanedSymbol.endsWith('-USDT') || cleanedSymbol.endsWith('-USDC')) {
    return cleanedSymbol;
  }
  
  // Remove existing suffix if any (for conversion)
  const baseSymbol = cleanedSymbol.replace(/-(USDT|USDC|VST)$/, '');
  
  // Add default USDT suffix if no suffix provided
  return `${baseSymbol}-USDT`;
}

// Get single asset details
router.get('/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const rawSymbol = req.params.symbol;
  const symbol = validateAndFormatSymbol(rawSymbol);
  
  const asset = await Asset.findOne({ where: { symbol } });
  
  if (!asset) {
    throw new AppError('Asset not found', 404);
  }
  
  // Get real-time data from BingX
  try {
    const ticker = await bingxClient.getTicker(symbol);
    if (ticker.code === 0 && ticker.data) {
      // Update asset with latest data
      asset.lastPrice = parseFloat(ticker.data.lastPrice);
      asset.priceChangePercent = parseFloat(ticker.data.priceChangePercent);
      asset.volume24h = parseFloat(ticker.data.volume);
      asset.quoteVolume24h = parseFloat(ticker.data.quoteVolume);
      asset.highPrice24h = parseFloat(ticker.data.highPrice);
      asset.lowPrice24h = parseFloat(ticker.data.lowPrice);
    }
  } catch (error) {
    logger.error(`Failed to get real-time data for ${symbol}:`, error);
  }
  
  res.json({
    success: true,
    data: asset
  });
}));

// Refresh assets from BingX API - RENDER PRODUCTION OPTIMIZED
router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  // RENDER CRITICAL: Set appropriate timeouts for platform constraints
  req.setTimeout(540000); // 9 minutes (under Render's 10-minute limit)
  res.setTimeout(540000);
  
  // RENDER MEMORY OPTIMIZATION: Monitor memory usage
  const startMemory = process.memoryUsage();
  logger.info('🚀 RENDER REFRESH START - Memory baseline:', {
    heapUsed: `${Math.round(startMemory.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(startMemory.heapTotal / 1024 / 1024)}MB`,
    rss: `${Math.round(startMemory.rss / 1024 / 1024)}MB`
  });
  
  const sessionId = req.body.sessionId || `refresh_${Date.now()}`;
  const totalStartTime = Date.now(); // Real total time measurement
  logger.info('🚀 RENDER: Refreshing assets with ProductionOptimizedBingXClient...', { 
    sessionId,
    client: 'production-optimized',
    platform: 'render'
  });
  
  try {
    // RENDER CRITICAL HEALTH CHECK: Verify system resources before starting
    const memCheck = process.memoryUsage();
    const memUsageMB = Math.round(memCheck.heapUsed / 1024 / 1024);
    
    // RENDER EMERGENCY: Refuse to start if memory is already critical
    if (memUsageMB > 450) {
      logger.error(`🚨 RENDER ABORT: Memory too high to start refresh (${memUsageMB}MB/512MB)`);
      
      await sendProgress(sessionId, {
        type: 'error',
        message: `🚨 RENDER: Cannot start refresh - memory usage too high (${memUsageMB}MB/512MB)`,
        errorDetails: {
          platform: 'render',
          memoryUsage: `${memUsageMB}MB`,
          memoryLimit: '512MB',
          recommendation: 'Wait 10 minutes for memory to stabilize, then try again'
        }
      });
      
      throw new AppError(`RENDER: Memory usage too high to start refresh (${memUsageMB}MB/512MB)`, 507);
    }
    
    // RENDER WARNING: High memory usage - force cleanup before proceeding
    if (memUsageMB > 350) {
      logger.warn(`⚠️ RENDER MEMORY WARNING: ${memUsageMB}MB used - forcing cleanup before refresh`);
      
      // Aggressive cleanup before starting
      if (global.gc) {
        global.gc();
        const afterGC = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        logger.info(`🧹 RENDER: Forced GC before refresh - ${memUsageMB}MB → ${afterGC}MB`);
        
        // Update memory usage after GC
        if (afterGC > 400) {
          logger.error(`🚨 RENDER: Memory still high after GC (${afterGC}MB) - delaying refresh`);
          
          await sendProgress(sessionId, {
            type: 'warning',
            message: `⚠️ RENDER: High memory after cleanup (${afterGC}MB) - using minimal processing mode`,
            memoryConstraint: true
          });
        }
      }
      
      // Clear any existing caches to free memory
      bingxClient.clearCache();
      
      // Wait briefly for system to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Send initial progress with system status
    await sendProgress(sessionId, {
      type: 'progress',
      message: `🚀 RENDER: Iniciando refresh (${memUsageMB}MB memória)...`,
      progress: 2,
      processed: 0,
      total: 0,
      systemInfo: { memoryMB: memUsageMB, platform: 'render' }
    });
    
    // Yield to event loop and send quick update
    await yieldEventLoop();
    
    // Invalidate cache to ensure fresh data
    bingxClient.clearCache();
    
    // OPTIMIZED: Controlled parallel fetch with rate limiting
    await sendProgress(sessionId, {
      type: 'progress',
      message: '🚀 Buscando contratos + dados de mercado (paralelo controlado)...',
      progress: 10,
      processed: 0,
      total: 0
    });
    
    let parallelData;
    let contractsResponse;
    let tickersResponse;
    
    try {
      // RENDER CRITICAL: Add circuit breaker pattern for API calls
      const apiStartTime = Date.now();
      logger.info('📡 RENDER: Starting BingX API calls with timeout protection...');
      
      // Wrap API call with timeout and memory monitoring
      const apiCallPromise = bingxClient.getSymbolsAndTickersOptimized();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('RENDER_API_TIMEOUT: BingX API call exceeded 120 seconds')), 120000);
      });
      
      parallelData = await Promise.race([apiCallPromise, timeoutPromise]) as any;
      contractsResponse = parallelData.symbols;
      tickersResponse = parallelData.tickers;
      
      const apiDuration = Date.now() - apiStartTime;
      logger.info(`✅ RENDER: BingX API calls completed in ${apiDuration}ms`);
      
    } catch (optimizedError: any) {
      logger.warn('⚠️  Optimized fetch failed, trying individual calls:', optimizedError.message);
      
      // Check if it's a rate limiter stopped error and restart
      if (optimizedError.message?.includes('limiter has been stopped') || 
          optimizedError.message?.includes('BingX rate limit active')) {
        logger.error('🚨 BingX rate limit detected:', optimizedError.message);
        
        if (optimizedError.message?.includes('minutes remaining')) {
          // Extract remaining time from error message
          const match = optimizedError.message.match(/(\d+) minutes remaining/);
          const remainingMinutes = match ? match[1] : 'unknown';
          
          await sendProgress(sessionId, {
            type: 'error',
            message: `🚨 RENDER: BingX rate limit detected. Please wait ${remainingMinutes} minutes.`,
            renderOptimized: true,
            retryAfter: remainingMinutes
          });
          
          throw new AppError(`RENDER: BingX rate limit active. Recovery in ${remainingMinutes} minutes.`, 429);
        }
        
        // RENDER SPECIFIC: Handle timeout errors gracefully
        if (optimizedError.message?.includes('RENDER_API_TIMEOUT')) {
          await sendProgress(sessionId, {
            type: 'error',
            message: '⏰ RENDER: API timeout - Render platform may be under high load. Please try again later.',
            renderOptimized: true
          });
          throw new AppError('RENDER: API timeout due to platform constraints', 504);
        }
        
        bingxClient.clearCache(); // This now also restarts limiters
        
        await sendProgress(sessionId, {
          type: 'progress',
          message: '🔄 Rate limiter recovered, retrying data fetch...',
          progress: 15,
          processed: 0,
          total: 0
        });
      }
      
      // Fallback to individual calls if optimized fetch fails
      try {
        contractsResponse = await bingxClient.getSymbols();
        
        // Try to get tickers individually with error handling
        try {
          tickersResponse = await bingxClient.getAllTickers();
        } catch (tickerError: any) {
          logger.warn('⚠️  Ticker fetch failed, proceeding with contracts only:', tickerError.message);
          tickersResponse = { code: 0, data: [], msg: 'Ticker data unavailable in production' };
        }
      } catch (contractError: any) {
        // Check if it's still a rate limiter error
        if (contractError.message?.includes('limiter has been stopped') ||
            contractError.message?.includes('BingX rate limit active')) {
          
          if (contractError.message?.includes('minutes remaining')) {
            const match = contractError.message.match(/(\d+) minutes remaining/);
            const remainingMinutes = match ? match[1] : 'unknown';
            
            await sendProgress(sessionId, {
              type: 'error',
              message: `⏳ BingX rate limit active. Please wait ${remainingMinutes} minutes before trying again.`
            });
            throw new AppError(`BingX rate limit active. Recovery in ${remainingMinutes} minutes.`, 429);
          }
          
          await sendProgress(sessionId, {
            type: 'error',
            message: 'BingX rate limit detected. Please wait up to 10 minutes before trying again.'
          });
          throw new AppError('BingX rate limit active. Please try again later.', 429);
        }
        
        await sendProgress(sessionId, {
          type: 'error',
          message: `Failed to fetch asset data: ${contractError.message}`
        });
        throw new AppError(`Failed to fetch asset data: ${contractError.message}`, 500);
      }
    }
    
    await sendProgress(sessionId, {
      type: 'progress', 
      message: `✅ Data fetched: ${contractsResponse?.data?.length || 0} contracts + ${tickersResponse?.data?.length || 0} tickers`,
      progress: 45,
      processed: 0,
      total: contractsResponse?.data?.length || 0,
      ...(tickersResponse?.data?.length === 0 && {
        warning: 'Market data unavailable - using contracts only'
      })
    });
    
    await yieldEventLoop();
    
    // Process contracts response
    const response = contractsResponse;
    
    logger.info('BingX responses received:', {
      contracts: {
        code: response?.code,
        dataLength: response?.data?.length,
        totalContracts: response?.data?.length || 0
      },
      tickers: {
        code: tickersResponse?.code,
        dataLength: tickersResponse?.data?.length,
        totalTickers: tickersResponse?.data?.length || 0,
        endpoint: tickersResponse?.source || 'unknown'
      }
    });
    
    // Check for API errors
    if (response.code !== 0 || !response.data) {
      await sendProgress(sessionId, {
        type: 'error',
        message: `BingX Contracts API Error: ${response.msg || 'Failed to fetch assets'}`
      });
      logger.error('BingX contracts API returned error:', {
        code: response.code,
        message: response.msg,
        data: response.data,
        fullResponse: response
      });
      throw new AppError(`BingX Contracts API Error: ${response.msg || 'Failed to fetch assets'}`, 500);
    }

    // Check for empty data (0 assets returned)
    if (response.data.length === 0) {
      await sendProgress(sessionId, {
        type: 'error',
        message: '⚠️ BingX returned 0 contracts - API may be blocked or rate limited in production'
      });
      logger.error('BingX returned empty contracts array:', {
        code: response.code,
        message: response.msg,
        dataLength: response.data.length,
        environment: process.env.NODE_ENV,
        renderIssue: 'BingX API returning empty data on Render'
      });
      throw new AppError('BingX API returned 0 contracts. This may be due to IP blocking or rate limiting on Render.', 500);
    }

    if (tickersResponse.code !== 0 || !tickersResponse.data) {
      logger.warn('BingX tickers API returned error - proceeding with contracts only:', {
        code: tickersResponse.code,
        message: tickersResponse.msg
      });
      // Continue without market data rather than failing completely
    }

    // Create ticker map for fast lookup
    const tickerMap = new Map<string, any>();
    if (tickersResponse.data && Array.isArray(tickersResponse.data)) {
      tickersResponse.data.forEach((ticker: any) => {
        if (ticker.symbol) {
          tickerMap.set(ticker.symbol, ticker);
        }
      });
      logger.info(`📊 Created ticker map with ${tickerMap.size} market data entries`);
    }
    
   
    const contractsToProcess = response.data;
    
    // 🔍 ANÁLISE DE CONTRATOS: Verificar duplicados mas SALVAR TODOS OS ÚNICOS
    const symbolCounts = new Map<string, number>();
    const duplicateSymbols: string[] = [];
    
    contractsToProcess.forEach((contract: any) => {
      if (contract.symbol) {
        const count = symbolCounts.get(contract.symbol) || 0;
        symbolCounts.set(contract.symbol, count + 1);
        if (count === 1) { // Segunda ocorrência
          duplicateSymbols.push(contract.symbol);
        }
      }
    });
    
    const uniqueSymbols = symbolCounts.size;
    const totalDuplicates = contractsToProcess.length - uniqueSymbols;
    
    logger.info(`🔍 ANÁLISE DE CONTRATOS (SALVAR TODOS):`, {
      totalContratos: contractsToProcess.length,
      simbolosUnicos: uniqueSymbols,
      duplicatas: totalDuplicates,
      exemplosDuplicatas: duplicateSymbols.slice(0, 5),
      STRATEGY: 'SAVE_ALL_UNIQUE_SYMBOLS'
    });
    
    if (totalDuplicates > 0) {
      logger.warn(`⚠️ ENCONTRADAS ${totalDuplicates} DUPLICATAS - Manteremos apenas uma ocorrência de cada símbolo único.`);
    }
    
    // CRITICAL FIX: Remove duplicates but keep ALL unique symbols
    const uniqueContracts = new Map<string, any>();
    contractsToProcess.forEach((contract: any) => {
      if (contract.symbol && !uniqueContracts.has(contract.symbol)) {
        uniqueContracts.set(contract.symbol, contract);
      }
    });
    
    // Use the deduplicated array for processing
    const contractsToProcessDeduped = Array.from(uniqueContracts.values());
    
    logger.info(`✅ DEDUPLICAÇÃO COMPLETA: ${contractsToProcessDeduped.length} contratos únicos serão processados`);
    
    // Update the processing array to use deduplicated contracts
    contractsToProcess.splice(0, contractsToProcess.length, ...contractsToProcessDeduped);
    
    // Send progress with total count - merge phase starting
    await sendProgress(sessionId, {
      type: 'progress',
      message: `🔄 Combinando dados: ${contractsToProcess.length} contratos + ${tickerMap.size} preços (${uniqueSymbols} únicos)`,
      progress: 55,
      processed: 0,
      total: contractsToProcess.length,
      uniqueSymbols,
      duplicates: totalDuplicates,
      marketDataCount: tickerMap.size
    });
    
    let created = 0;
    let updated = 0;
    let processed = 0;
    let skipped = 0; // Contratos que não foram processados (duplicados, inválidos, etc)
    let withMarketData = 0; // Contratos que foram enriched com market data
    let withoutMarketData = 0; // Contratos sem market data
    const statusCounts = {
      TRADING: 0,
      SUSPENDED: 0,
      DELISTED: 0,
      MAINTENANCE: 0,
      UNKNOWN: 0
    };
    
    
    // RENDER OPTIMIZED: Memory-conscious parallel processing
    const startTime = Date.now();
    
    // RENDER CRITICAL: Memory-aware batch sizing with emergency protocols
    const currentMemory = process.memoryUsage();
    const currentMemUsageMB = Math.round(currentMemory.heapUsed / 1024 / 1024);
    
    // RENDER EMERGENCY: Abort if memory is already critical
    if (currentMemUsageMB > 480) {
      logger.error(`🚨 RENDER ABORT: Critical memory usage (${currentMemUsageMB}MB) before processing - aborting to prevent crash`);
      throw new AppError(`RENDER: Memory usage too high (${currentMemUsageMB}MB/512MB) - please try again later`, 507);
    }
    
    // Dynamic batch sizing based on available memory - more aggressive limits
    let BATCH_SIZE = 30; // Very conservative for Render's 512MB limit
    let MAX_CONCURRENT_BATCHES = 2; // Reduced concurrency
    
    if (currentMemUsageMB > 350) {
      BATCH_SIZE = 15; // Ultra conservative
      MAX_CONCURRENT_BATCHES = 1; // Sequential processing only
      logger.warn(`🚨 RENDER: High memory usage (${currentMemUsageMB}MB), using ultra-conservative batch sizes`);
      
      // Force garbage collection before proceeding
      if (global.gc) {
        global.gc();
        const afterGC = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        logger.info(`🧹 RENDER: Forced GC - memory reduced from ${currentMemUsageMB}MB to ${afterGC}MB`);
      }
    } else if (currentMemUsageMB > 300) {
      BATCH_SIZE = 20; // Conservative
      MAX_CONCURRENT_BATCHES = 1;
      logger.warn(`⚠️ RENDER: Moderate memory usage (${currentMemUsageMB}MB), using conservative batch sizes`);
    }
    
    // RENDER: Additional safety - limit total contracts if memory is constrained
    const memoryAvailableMB = 512 - currentMemUsageMB;
    const maxContractsForMemory = Math.min(contractsToProcess.length, Math.floor(memoryAvailableMB * 20)); // ~20 contracts per MB
    
    if (maxContractsForMemory < contractsToProcess.length) {
      logger.warn(`🔒 RENDER: Memory constraint - processing only ${maxContractsForMemory}/${contractsToProcess.length} contracts`);
      contractsToProcess.splice(maxContractsForMemory);
      
      await sendProgress(sessionId, {
        type: 'warning',
        message: `⚠️ RENDER: Memory limited - processing ${maxContractsForMemory} contracts only`,
        memoryConstraint: true,
        availableMemory: `${memoryAvailableMB}MB`
      });
    }
    
    logger.info(`🔧 RENDER BATCH CONFIG: ${BATCH_SIZE} per batch, ${MAX_CONCURRENT_BATCHES} concurrent`);
    
    // Prepare all asset data in parallel batches
    const batches = [];
    for (let i = 0; i < contractsToProcess.length; i += BATCH_SIZE) {
      batches.push(contractsToProcess.slice(i, i + BATCH_SIZE));
    }
    
    logger.info(`📦 Created ${batches.length} batches of ~${BATCH_SIZE} contracts each for parallel processing`);
    
    // Process batches with controlled concurrency
    const processedAssets: any[] = [];    
    const processBatch = async (batch: any[], batchIndex: number): Promise<any[]> => {
      const batchAssets: any[] = [];
      
      for (let i = 0; i < batch.length; i++) {
        const contract = batch[i];
        processed++;
        
        // Send progress updates less frequently to reduce overhead
        if (processed % 200 === 0 || processed === contractsToProcess.length) {
          const progress = Math.min(75, Math.round(55 + (processed / contractsToProcess.length) * 20));
          await sendProgress(sessionId, {
            type: 'progress',
            message: `🚀 Processamento paralelo: Lote ${batchIndex + 1}/${batches.length} (${processed}/${contractsToProcess.length})`,
            progress,
            processed,
            total: contractsToProcess.length,
            current: contract.symbol
          });
        }
      
      // Log first few contracts for debugging
      if (processed <= 3) {
        logger.debug(`Processing contract ${processed}:`, {
          symbol: contract.symbol,
          contractType: contract.contractType,
          status: contract.status
        });
      }
      
      // Process ALL contracts regardless of status (active, inactive, suspended)
      // We want to show everything in the interface
      if (processed <= 5) {
        logger.debug(`Processing contract ${processed}:`, {
          symbol: contract.symbol,
          status: contract.status,
          statusText: contract.status === 1 ? 'TRADING' : 'INACTIVE/SUSPENDED'
        });
      }
      
      // Map BingX status codes to descriptive text - CORRIGIDO
      let statusText = 'UNKNOWN';
      
      // Log para debug dos primeiros contratos
      if (processed <= 5) {
        logger.info(`🔍 Status debug para ${contract.symbol}:`, {
          status: contract.status,
          statusType: typeof contract.status,
          statusString: String(contract.status)
        });
      }
      
      // Converter para número se for string
      const statusCode = typeof contract.status === 'string' ? parseInt(contract.status) : contract.status;
      
      switch (statusCode) {
        case 1:
          statusText = 'TRADING';
          break;
        case 0:
          statusText = 'SUSPENDED';
          break;
        case 2:
          statusText = 'DELISTED';
          break;
        case 3:
          statusText = 'MAINTENANCE';
          break;
        default:
          // Se status for undefined, null ou inválido, usar UNKNOWN
          if (contract.status === undefined || contract.status === null) {
            statusText = 'UNKNOWN';
            if (processed <= 10) {
              logger.warn(`⚠️ Status undefined para ${contract.symbol}, usando UNKNOWN`);
            }
          } else {
            statusText = 'UNKNOWN'; // Não mais STATUS_undefined
            if (processed <= 10) {
              logger.warn(`⚠️ Status desconhecido '${contract.status}' para ${contract.symbol}, usando UNKNOWN`);
            }
          }
      }

      // Get market data for this symbol
      const ticker = tickerMap.get(contract.symbol);
      
      // Count market data availability
      if (ticker) {
        withMarketData++;
      } else {
        withoutMarketData++;
      }
      
      const assetData: any = {
        // Contract metadata (from contracts API)
        symbol: contract.symbol,
        name: contract.displayName || contract.symbol,
        baseCurrency: contract.asset || 'UNKNOWN',           // BTC, ETH, etc.
        quoteCurrency: contract.currency || 'USDT',          // USDT
        status: statusText, // Já corrigido acima
        minQty: parseFloat(contract.tradeMinQuantity || contract.size || '0') || 0,
        maxQty: parseFloat(contract.maxQty || '999999999') || 999999999,
        tickSize: contract.pricePrecision ? Math.pow(10, -contract.pricePrecision) : 0.0001,
        stepSize: contract.quantityPrecision ? Math.pow(10, -contract.quantityPrecision) : 0.001,
        maxLeverage: parseInt(contract.maxLeverage || '100') || 100,
        maintMarginRate: parseFloat(contract.feeRate || '0') || 0,
        
        // Market data (real-time from tickers API) - THIS IS THE KEY FIX!
        lastPrice: ticker ? parseFloat(ticker.lastPrice || '0') || 0 : 0,
        priceChangePercent: ticker ? parseFloat(ticker.priceChangePercent || '0') || 0 : 0,
        volume24h: ticker ? parseFloat(ticker.volume || '0') || 0 : 0,
        quoteVolume24h: ticker ? parseFloat(ticker.quoteVolume || ticker.turnover || '0') || 0 : 0,
        highPrice24h: ticker ? parseFloat(ticker.highPrice || '0') || 0 : 0,
        lowPrice24h: ticker ? parseFloat(ticker.lowPrice || '0') || 0 : 0,
        openInterest: ticker ? parseFloat(ticker.openInterest || '0') || 0 : 0
      };
      
      // CRITICAL: FORCE SAVE ALL CONTRACTS - ensure no values break database
      assetData.symbol = assetData.symbol || `UNKNOWN_${processed}_${Date.now()}`;
      assetData.name = assetData.name || assetData.symbol;
      assetData.baseCurrency = assetData.baseCurrency || 'UNKNOWN';
      assetData.quoteCurrency = assetData.quoteCurrency || 'USDT';
      assetData.status = assetData.status || 'UNKNOWN';
      
      // Ensure all numbers are valid (no NaN, null, undefined)
      const numericFields = [
        'lastPrice', 'priceChangePercent', 'volume24h', 'quoteVolume24h', 
        'highPrice24h', 'lowPrice24h', 'openInterest', 'minQty', 'maxQty', 
        'tickSize', 'stepSize', 'maxLeverage', 'maintMarginRate'
      ];
      
      numericFields.forEach(field => {
        if (typeof assetData[field] !== 'number' || isNaN(assetData[field]) || !isFinite(assetData[field])) {
          assetData[field] = 0;
        }
      });
      
      // CRITICAL: Validate required fields are not null/empty
      if (!assetData.symbol || assetData.symbol.trim() === '') {
        logger.error(`🚨 CRITICAL: Asset without symbol at position ${processed}`);
        assetData.symbol = `EMERGENCY_${processed}_${Date.now()}`;
      }
      
      // Log first few asset data for debugging
      if (processed <= 3) {
        logger.debug(`Asset data ${processed}:`, assetData);
      }
      
      // CRITICAL: ACCEPT ALL CONTRACTS - Validate only minimum symbol requirement
      if (!contract.symbol || contract.symbol.trim() === '') {
        // Create temporary symbol if none exists - we still want to save it
        const tempSymbol = `UNKNOWN_${processed}_${Date.now()}`;
        logger.warn(`⚠️ Contract without symbol, creating temporary: ${tempSymbol}`);
        contract.symbol = tempSymbol;
        assetData.symbol = tempSymbol; // Ensure assetData has the symbol too
      }
      
      // CRITICAL DEBUG: Log if any contract is being skipped (there should be NONE)
      if (processed <= 10) {
        logger.info(`✅ PROCESSING CONTRACT ${processed}/${contractsToProcess.length}: ${contract.symbol} (${statusText})`);
      }

      // Log detalhado dos primeiros contratos para debug
      if (processed <= 5) {
        logger.info(`📝 DADOS COMPLETOS - Preparando asset ${processed}:`, {
          symbol: contract.symbol,
          originalStatus: contract.status,
          processedStatus: statusText,
          hasBaseCurrency: !!contract.asset,
          hasQuoteCurrency: !!contract.currency,
          hasMarketData: !!ticker,
          marketData: ticker ? {
            lastPrice: ticker.lastPrice,
            volume: ticker.volume,
            priceChangePercent: ticker.priceChangePercent
          } : 'NO_MARKET_DATA',
          mergedData: {
            lastPrice: assetData.lastPrice,
            volume24h: assetData.volume24h,
            priceChangePercent: assetData.priceChangePercent
          }
        });
      }

        // CRITICAL: Store prepared asset data for bulk processing - EVERY contract MUST be saved
        batchAssets.push(assetData);
        
        // VALIDATION: Ensure we're not losing any contracts
        if (processed <= 10) {
          logger.info(`✅ ADDED TO BATCH ${processed}: ${assetData.symbol} - BatchSize: ${batchAssets.length}`);
        }
        
        // Count status distribution for metrics
        if (statusCounts.hasOwnProperty(statusText)) {
          statusCounts[statusText as keyof typeof statusCounts]++;
        } else {
          statusCounts.UNKNOWN++;
        }
      }
      
      return batchAssets;
    };
    
    // Execute batches with controlled concurrency
    const allBatchPromises: Promise<any[]>[] = [];
    
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
      const concurrentBatches = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
      const batchPromises = concurrentBatches.map((batch, index) => 
        processBatch(batch, i + index)
      );
      
      // Process batches in parallel within the concurrency limit
      const batchResults = await Promise.all(batchPromises);
      allBatchPromises.push(...batchPromises);
      
      // Flatten results and prepare for bulk database operations
      const flattenedAssets = batchResults.flat();
      processedAssets.push(...flattenedAssets);
      
      // RENDER CRITICAL: Monitor memory during processing with emergency protocols
      const processingMemory = process.memoryUsage();
      const processingMemMB = Math.round(processingMemory.heapUsed / 1024 / 1024);
      
      // RENDER EMERGENCY: Abort if memory becomes critical during processing
      if (processingMemMB > 490) {
        logger.error(`🚨 RENDER EMERGENCY ABORT: Critical memory (${processingMemMB}MB) during processing`);
        
        // Emergency cleanup
        if (global.gc) {
          global.gc();
          const postGCMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          logger.info(`🧹 RENDER EMERGENCY: Post-GC memory: ${postGCMemory}MB`);
          
          // If still critical after GC, abort with partial results
          if (postGCMemory > 480) {
            await sendProgress(sessionId, {
              type: 'warning',
              message: `🚨 RENDER: Emergency stop due to memory pressure - saved ${processedAssets.length} assets`,
              partialResults: true,
              memoryUsage: `${postGCMemory}MB`
            });
            break; // Exit batch processing loop early
          }
        } else {
          // No GC available, must abort
          await sendProgress(sessionId, {
            type: 'error',
            message: `🚨 RENDER: Critical memory exceeded (${processingMemMB}MB) - operation aborted`,
            memoryExceeded: true
          });
          throw new AppError(`RENDER: Memory exceeded during processing (${processingMemMB}MB/512MB)`, 507);
        }
      }
      
      // Send bulk database progress update with enhanced memory monitoring
      await sendProgress(sessionId, {
        type: 'progress',
        message: `💾 RENDER: Salvando lote (${processingMemMB}MB): ${processedAssets.length} contratos`,
        progress: Math.min(85, 75 + (processedAssets.length / contractsToProcess.length) * 10),
        processed: processedAssets.length,
        total: contractsToProcess.length,
        memoryUsage: `${processingMemMB}MB`,
        memoryPercentage: `${((processingMemMB / 512) * 100).toFixed(1)}%`,
        renderOptimized: true
      });
      
      // RENDER: Proactive garbage collection at memory thresholds
      if (processingMemMB > 350 && global.gc) {
        global.gc();
        const afterGCMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        logger.info(`🧹 RENDER: Proactive GC - ${processingMemMB}MB → ${afterGCMemory}MB`);
      }
      
      // RENDER: Additional cleanup for large batches
      if (processedAssets.length > 500 && processedAssets.length % 100 === 0) {
        // Clear processed batch data to free memory
        const earliestBatches = Math.floor(processedAssets.length / 100) - 2;
        if (earliestBatches > 0) {
          logger.debug(`🧹 RENDER: Clearing early batch references to save memory`);
        }
      }
      
      // Yield to event loop between batch groups
      await yieldEventLoop();
    }
    
    // BULK DATABASE OPERATIONS - Major performance improvement
    await sendProgress(sessionId, {
      type: 'progress',
      message: `💾 Operação bulk no banco: ${processedAssets.length} contratos`,
      progress: 90,
      processed: processedAssets.length,
      total: contractsToProcess.length
    });
    
    try {
      // RENDER OPTIMIZED: Database operations with error recovery
      logger.info(`💾 RENDER: Starting bulk database operation for ${processedAssets.length} assets...`);
      
      const dbStartTime = Date.now();
      const bulkResult = await Promise.race([
        Asset.bulkCreate(processedAssets, {
          updateOnDuplicate: [
            'name', 'baseCurrency', 'quoteCurrency', 'status', 'minQty', 'maxQty',
            'tickSize', 'stepSize', 'maxLeverage', 'maintMarginRate', 'lastPrice',
            'priceChangePercent', 'volume24h', 'quoteVolume24h', 'highPrice24h',
            'lowPrice24h', 'openInterest', 'updatedAt'
          ],
          returning: false, // Improve performance
          validate: false,  // Skip validation for performance
          ignoreDuplicates: false // Handle duplicates via updateOnDuplicate
        }),
        // RENDER: Add database timeout protection
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('RENDER_DB_TIMEOUT: Database operation exceeded 60 seconds')), 60000);
        })
      ]) as any[];
      
      const dbDuration = Date.now() - dbStartTime;
      logger.info(`✅ RENDER: Database bulk operation completed in ${dbDuration}ms`);
      
      // Count operations (approximate since bulkCreate doesn't distinguish created vs updated easily)
      const existingCount = await Asset.count();
      const newRecordsCreated = Math.max(0, bulkResult.length - (existingCount - bulkResult.length));
      const recordsUpdated = bulkResult.length - newRecordsCreated;
      
      created = newRecordsCreated;
      updated = recordsUpdated;
      skipped = contractsToProcess.length - bulkResult.length;
      
      logger.info(`🚀 BULK OPERATION COMPLETED:`, {
        totalProcessed: bulkResult.length,
        estimatedCreated: created,
        estimatedUpdated: updated,
        skipped,
        totalContracts: contractsToProcess.length,
        processedAssets: processedAssets.length,
        VALIDATION: bulkResult.length === processedAssets.length ? 'ALL_SAVED' : 'SOME_LOST'
      });
      
      // CRITICAL VALIDATION: Check if we lost any contracts during bulk operation
      if (bulkResult.length !== processedAssets.length) {
        logger.error(`🚨 CRITICAL: Database bulk operation lost contracts!`, {
          prepared: processedAssets.length,
          savedToDB: bulkResult.length,
          lost: processedAssets.length - bulkResult.length
        });
      }
      
      // FINAL VALIDATION: Verify all unique symbols are in database
      const finalCount = await Asset.count();
      logger.info(`📊 FINAL DATABASE COUNT: ${finalCount} total assets in database`);
      
    } catch (bulkError: any) {
      logger.error(`❌ RENDER BULK DATABASE ERROR:`, {
        message: bulkError.message,
        type: bulkError.constructor.name,
        isTimeout: bulkError.message?.includes('RENDER_DB_TIMEOUT')
      });
      
      // RENDER SPECIFIC: Handle database timeout gracefully
      if (bulkError.message?.includes('RENDER_DB_TIMEOUT')) {
        await sendProgress(sessionId, {
          type: 'warning',
          message: '⚠️ RENDER: Database timeout - falling back to batch processing...'
        });
      }
      
      // Fallback to smaller batches for Render reliability
      logger.info(`🔄 RENDER: Falling back to smaller batch upserts...`);
      const FALLBACK_BATCH_SIZE = 10; // Very small batches for reliability
      // RENDER OPTIMIZED: Process in smaller batches to avoid memory issues
      for (let i = 0; i < processedAssets.length; i += FALLBACK_BATCH_SIZE) {
        const fallbackBatch = processedAssets.slice(i, i + FALLBACK_BATCH_SIZE);
        
        for (const assetData of fallbackBatch) {
          try {
            const [, wasCreated] = await Asset.upsert(assetData, {
              returning: true
            });
            
            if (wasCreated) {
              created++;
            } else {
              updated++;
            }
          } catch (individualError: any) {
            logger.error(`❌ RENDER: Individual upsert failed for ${assetData.symbol}:`, individualError);
            skipped++;
          }
        }
        
        // RENDER: Yield to event loop between batches
        if (i % 50 === 0) {
          await yieldEventLoop();
          const currentMem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          logger.info(`🔄 RENDER: Fallback batch ${Math.floor(i/FALLBACK_BATCH_SIZE)+1} completed (${currentMem}MB)`);
        }
      }
    }
    
    // RENDER: Final memory and performance metrics
    const finalMemory = process.memoryUsage();
    const finalMemMB = Math.round(finalMemory.heapUsed / 1024 / 1024);
    const memoryDelta = finalMemMB - Math.round(startMemory.heapUsed / 1024 / 1024);
    
    const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const assetsPerSecond = ((created + updated) / parseFloat(processingTime)).toFixed(1);
    const totalSaved = created + updated;
    const successRate = ((totalSaved / processed) * 100).toFixed(1);
    
    logger.info(`🏁 RENDER PERFORMANCE SUMMARY:`, {
      totalTime: `${totalTime}s`,
      memoryUsed: `${finalMemMB}MB (Δ${memoryDelta >= 0 ? '+' : ''}${memoryDelta}MB)`,
      successRate: `${successRate}%`,
      throughput: `${assetsPerSecond} assets/second`
    });
    
    // ANÁLISE CRÍTICA: Por que contratos foram perdidos?
    const contractsLost = processed - totalSaved;
    if (contractsLost > 0) {
      logger.error(`🚨 PROBLEMA CRÍTICO: ${contractsLost} contratos foram perdidos!`, {
        contratosTotais: contractsToProcess.length,
        processados: processed,
        salvosNoBanco: totalSaved,
        perdidos: contractsLost,
        taxaSucesso: `${successRate}%`,
        created,
        updated,
        skipped
      });
    }
    
    logger.info(`Assets refresh completed:`, {
      discovery: {
        totalContracts: contractsToProcess.length,
        processedContracts: processed,
        savedToDatabase: totalSaved,
        lostContracts: contractsLost,
        successRate: `${successRate}%`
      },
      marketData: {
        totalTickers: tickerMap.size,
        withMarketData,
        withoutMarketData,
        enrichmentRate: `${((withMarketData / processed) * 100).toFixed(1)}%`
      },
      database: {
        created,
        updated,
        skipped
      },
      statusDistribution: statusCounts,
      performance: {
        totalExecutionTime: `${totalTime}s`,
        processingTime: `${processingTime}s`,
        assetsPerSecond: `${assetsPerSecond} assets/second`
      }
    });
    
    // Send final progress with CORRECT metrics
    const enrichmentRate = ((withMarketData / processed) * 100).toFixed(1);
    await sendProgress(sessionId, {
      type: 'completed',
      message: `✅ RENDER: ${totalSaved} contratos salvos (${enrichmentRate}% enriched) - ${totalTime}s total`,
      progress: 100,
      processed,
      total: contractsToProcess.length,
      created,
      updated,
      skipped: contractsLost,
      savedToDatabase: totalSaved,
      marketData: {
        totalTickers: tickerMap.size,
        withMarketData,
        withoutMarketData,
        enrichmentRate: `${enrichmentRate}%`
      },
      statusDistribution: statusCounts,
      performance: {
        totalExecutionTime: totalTime,
        processingTime: processingTime,
        throughput: `${assetsPerSecond} assets/second`,
        memoryUsage: `${finalMemMB}MB`,
        memoryDelta: `${memoryDelta >= 0 ? '+' : ''}${memoryDelta}MB`,
        platform: 'render'
      },
      successRate: `${successRate}%`,
      contractsLost,
      renderOptimized: true
    });
    
    // Close SSE connection
    const session = refreshSessions.get(sessionId);
    if (session) {
      session.end();
      refreshSessions.delete(sessionId);
    }
    
    res.json({
      success: true,
      data: {
        message: 'RENDER: Assets refreshed successfully',
        created,
        updated,
        total: contractsToProcess.length,
        processed,
        statusDistribution: statusCounts,
        sessionId,
        performance: {
          executionTime: `${totalTime}s`,
          memoryUsage: `${finalMemMB}MB`,
          platform: 'render',
          optimized: true
        }
      }
    });
    
  } catch (error) {
    // RENDER CRITICAL: Enhanced error handling with memory diagnostics
    const errorMemory = process.memoryUsage();
    const errorMemMB = Math.round(errorMemory.heapUsed / 1024 / 1024);
    
    // RENDER EMERGENCY: Force garbage collection if memory is critical
    if (errorMemMB > 480 && global.gc) {
      global.gc();
      logger.info('🚨 RENDER EMERGENCY: Forced GC due to critical memory usage');
    }
    
    logger.error('RENDER: Assets refresh failed:', {
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: process.env.NODE_ENV === 'development' ? error.stack?.substring(0, 1000) : 'hidden'
      } : error,
      memoryAtError: `${errorMemMB}MB`,
      isMemoryIssue: errorMemMB > 450,
      isMemoryCritical: errorMemMB > 480,
      isTimeoutIssue: error instanceof Error && (
        error.message?.includes('timeout') || 
        error.message?.includes('TIMEOUT') ||
        error.message?.includes('ECONNABORTED') ||
        error.message?.includes('ETIMEDOUT')
      ),
      isNetworkIssue: error instanceof Error && (
        error.message?.includes('ECONNRESET') ||
        error.message?.includes('ENOTFOUND') ||
        error.message?.includes('network')
      )
    });
    
    // RENDER: Enhanced error classification for better debugging
    let errorMessage = 'Unknown error during refresh';
    let errorCode = 500;
    
    if (error instanceof Error) {
      // Memory-related errors
      if (errorMemMB > 480) {
        errorMessage = 'RENDER: Memory limit exceeded (>480MB) - operation aborted for platform stability';
        errorCode = 507;
      } else if (errorMemMB > 450 && error.message?.includes('out of memory')) {
        errorMessage = 'RENDER: Out of memory - try refreshing with fewer concurrent operations';
        errorCode = 507;
      }
      // API timeout errors
      else if (error.message?.includes('RENDER_API_TIMEOUT')) {
        errorMessage = 'RENDER: BingX API timeout - platform may be under high load';
        errorCode = 504;
      } else if (error.message?.includes('RENDER_DB_TIMEOUT')) {
        errorMessage = 'RENDER: Database timeout - database may be overloaded';
        errorCode = 503;
      }
      // Network errors
      else if (error.message?.includes('ECONNRESET') || error.message?.includes('ENOTFOUND')) {
        errorMessage = 'RENDER: Network connectivity issue - check BingX API status';
        errorCode = 502;
      } else if (error.message?.includes('ETIMEDOUT')) {
        errorMessage = 'RENDER: Request timeout - external API unresponsive';
        errorCode = 504;
      }
      // Rate limiting
      else if (error.message?.includes('rate limit')) {
        errorMessage = `RENDER: ${error.message}`;
        errorCode = 429;
      }
      // Generic fallback
      else {
        errorMessage = `RENDER: ${error.message}`;
        // Keep original error code if it's an AppError
        if (error.name === 'AppError' && (error as any).statusCode) {
          errorCode = (error as any).statusCode;
        }
      }
    }
    
    // RENDER: Send comprehensive error information
    await sendProgress(sessionId, {
      type: 'error',
      message: errorMessage,
      errorDetails: {
        platform: 'render',
        memoryUsage: `${errorMemMB}MB`,
        memoryLimit: '512MB',
        memoryUtilization: `${((errorMemMB / 512) * 100).toFixed(1)}%`,
        errorType: error instanceof Error ? error.name : 'Unknown',
        errorCategory: errorCode === 507 ? 'memory' : errorCode === 504 ? 'timeout' : errorCode === 502 ? 'network' : 'unknown',
        timestamp: new Date().toISOString(),
        recommendation: errorMemMB > 450 
          ? 'Wait 5 minutes and try again with fewer assets' 
          : 'Check BingX API status or try again later'
      },
      renderOptimized: true
    });
    
    // RENDER CRITICAL: Cleanup resources before throwing
    try {
      // Clear any remaining caches
      bingxClient?.clearCache?.();
      
      // Force garbage collection to free memory
      if (global.gc) {
        global.gc();
        logger.info('🧹 RENDER: Emergency cleanup - forced GC on error');
      }
      
      // Close SSE connection
      const session = refreshSessions.get(sessionId);
      if (session) {
        session.end();
        refreshSessions.delete(sessionId);
      }
    } catch (cleanupError) {
      logger.warn('RENDER: Error during cleanup:', cleanupError);
    }
    
    throw new AppError(errorMessage, errorCode);
  }
}));

// Get asset statistics
router.get('/stats/overview', asyncHandler(async (_req: Request, res: Response) => {
  const totalAssets = await Asset.count();
  const tradingAssets = await Asset.count({ where: { status: 'TRADING' } });
  
  const topGainers = await Asset.findAll({
    where: { status: 'TRADING' },
    order: [['priceChangePercent', 'DESC']],
    limit: 5
  });
  
  const topLosers = await Asset.findAll({
    where: { status: 'TRADING' },
    order: [['priceChangePercent', 'ASC']],
    limit: 5
  });
  
  const topVolume = await Asset.findAll({
    where: { status: 'TRADING' },
    order: [['quoteVolume24h', 'DESC']],
    limit: 5
  });
  
  res.json({
    success: true,
    data: {
      totalAssets,
      tradingAssets,
      topGainers,
      topLosers,
      topVolume
    }
  });
}));

// Smart cache management endpoint
router.post('/cache/invalidate', asyncHandler(async (_req: Request, res: Response) => {
  logger.info('🔄 Cache invalidation requested');
  
  try {
    // Invalidate BingX client caches
    bingxClient.clearCache();
    
    logger.info('✅ All caches invalidated successfully');
    
    res.json({
      success: true,
      data: {
        message: 'All caches invalidated successfully',
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    logger.error('❌ Failed to invalidate caches:', error);
    throw new AppError('Failed to invalidate caches', 500);
  }
}));

// Delta update endpoint for incremental refresh
router.post('/refresh/delta', asyncHandler(async (req: Request, res: Response) => {
  const sessionId = req.body.sessionId || `delta_refresh_${Date.now()}`;
  const totalStartTime = Date.now();
  logger.info('Starting delta refresh (incremental update)...', { sessionId });
  
  try {
    // Send initial progress
    await sendProgress(sessionId, {
      type: 'progress',
      message: 'Iniciando atualização incremental...',
      progress: 5,
      processed: 0,
      total: 0
    });
    
    // Get last update time from database
    const lastAsset = await Asset.findOne({
      order: [['updatedAt', 'DESC']],
      attributes: ['updatedAt']
    });
    
    const lastUpdateTime = lastAsset?.updatedAt || new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago if no assets
    const hoursSinceUpdate = (Date.now() - lastUpdateTime.getTime()) / (1000 * 60 * 60);
    
    logger.info(`📊 Delta update analysis:`, {
      lastUpdate: lastUpdateTime.toISOString(),
      hoursSinceUpdate: hoursSinceUpdate.toFixed(2),
      isRecentUpdate: hoursSinceUpdate < 1
    });
    
    // If data is very recent (< 1 hour), only update market data (prices)
    if (hoursSinceUpdate < 1) {
      await sendProgress(sessionId, {
        type: 'progress',
        message: 'Dados recentes detectados - atualizando apenas preços...',
        progress: 20,
        processed: 0,
        total: 0
      });
      
      // Quick market data update only
      const tickersResponse = await bingxClient.getAllTickers();
      if (tickersResponse.code === 0 && tickersResponse.data) {
        const tickerMap = new Map<string, any>();
        tickersResponse.data.forEach((ticker: any) => {
          if (ticker.symbol) {
            tickerMap.set(ticker.symbol, ticker);
          }
        });
        
        // Update only market data fields for existing assets
        let updated = 0;
        const existingAssets = await Asset.findAll({ attributes: ['symbol'] });
        
        for (const asset of existingAssets) {
          const ticker = tickerMap.get(asset.symbol);
          if (ticker) {
            await Asset.update({
              lastPrice: parseFloat(ticker.lastPrice || '0') || 0,
              priceChangePercent: parseFloat(ticker.priceChangePercent || '0') || 0,
              volume24h: parseFloat(ticker.volume || '0') || 0,
              quoteVolume24h: parseFloat(ticker.quoteVolume || ticker.turnover || '0') || 0,
              highPrice24h: parseFloat(ticker.highPrice || '0') || 0,
              lowPrice24h: parseFloat(ticker.lowPrice || '0') || 0,
              openInterest: parseFloat(ticker.openInterest || '0') || 0,
              updatedAt: new Date()
            }, {
              where: { symbol: asset.symbol }
            });
            updated++;
          }
        }
        
        const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
        
        await sendProgress(sessionId, {
          type: 'completed',
          message: `✅ DELTA RÁPIDO: ${updated} preços atualizados em ${totalTime}s`,
          progress: 100,
          processed: updated,
          total: existingAssets.length,
          updated,
          created: 0,
          skipped: existingAssets.length - updated,
          executionTime: totalTime,
          deltaMode: 'MARKET_DATA_ONLY'
        });
        
        res.json({
          success: true,
          data: {
            message: 'Delta refresh completed (market data only)',
            updated,
            created: 0,
            total: existingAssets.length,
            sessionId,
            deltaMode: 'MARKET_DATA_ONLY',
            executionTime: totalTime
          }
        });
        return;
      }
    }
    
    // For older data, fall back to full refresh
    await sendProgress(sessionId, {
      type: 'progress',
      message: 'Dados antigos detectados - executando refresh completo...',
      progress: 10,
      processed: 0,
      total: 0
    });
    
    // Forward to full refresh
    req.url = '/refresh';
    req.body.sessionId = sessionId;
    req.body.deltaFallback = true;
    
    // Close current SSE and let full refresh handle it
    const session = refreshSessions.get(sessionId);
    if (session) {
      session.end();
      refreshSessions.delete(sessionId);
    }
    
    // This will trigger a full refresh
    res.json({
      success: true,
      data: {
        message: 'Delta refresh fallback to full refresh',
        sessionId,
        deltaMode: 'FULL_REFRESH_FALLBACK',
        reason: `Data is ${hoursSinceUpdate.toFixed(1)} hours old`
      }
    });
    
  } catch (error) {
    logger.error('Failed to perform delta refresh:', error);
    
    await sendProgress(sessionId, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error during delta refresh'
    });
    
    const session = refreshSessions.get(sessionId);
    if (session) {
      session.end();
      refreshSessions.delete(sessionId);
    }
    
    throw new AppError('Failed to perform delta refresh', 500);
  }
}));

// Clear all assets from database
router.delete('/clear', asyncHandler(async (_req: Request, res: Response) => {
  logger.info('🗑️ CLEAR ENDPOINT HIT: Clearing all assets from database...');
  console.log('🗑️ CLEAR ENDPOINT: Request received');
  
  try {
    logger.info('🔄 Contando assets antes da limpeza...');
    const countBefore = await Asset.count();
    logger.info(`📊 Assets no banco antes da limpeza: ${countBefore}`);
    
    logger.info('🗑️ Executando Asset.destroy...');
    const deletedCount = await Asset.destroy({
      where: {},
      truncate: true // More efficient for clearing all records
    });
    
    logger.info(`✅ Successfully cleared ${deletedCount} assets from database`);
    console.log(`✅ CLEAR ENDPOINT: ${deletedCount} assets removidos`);
    
    const response = {
      success: true,
      data: {
        message: 'All assets cleared from database',
        deletedCount: deletedCount || countBefore // Fallback para truncate
      }
    };
    
    logger.info('📤 Enviando resposta:', response);
    res.json(response);
    
  } catch (error) {
    logger.error('❌ Failed to clear assets:', error);
    console.error('❌ CLEAR ENDPOINT ERROR:', error);
    throw new AppError('Failed to clear assets from database', 500);
  }
}));

// Rate limiter status endpoint
router.get('/debug/rate-limit-status', asyncHandler(async (_req: Request, res: Response) => {
  const status = bingxClient.getRateLimitStatus();
  
  res.json({
    success: true,
    data: {
      ...status,
      timestamp: new Date().toISOString(),
      recommendation: status.rateLimitStatus.isRateLimited 
        ? `Wait ${Math.ceil(status.rateLimitStatus.remainingSeconds / 60)} minutes before making requests`
        : 'Rate limiter is operational'
    }
  });
}));

// Debug endpoint for production troubleshooting
router.get('/debug/api-test', asyncHandler(async (req: Request, res: Response) => {
  const debugInfo: any = {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    server: 'render',
    checks: {}
  };

  try {
    // Test 1: Basic BingX connectivity using public method
    debugInfo.checks.bingx_connectivity = 'testing...';
    const testResponse = await bingxClient.getSymbols();
    debugInfo.checks.bingx_connectivity = {
      status: 'success',
      responseCode: testResponse.code,
      dataLength: testResponse.data?.length || 0,
      message: testResponse.msg
    };
  } catch (error: any) {
    debugInfo.checks.bingx_connectivity = {
      status: 'error',
      message: error.message,
      code: error.code,
      timeout: error.code === 'ECONNABORTED'
    };
  }

  try {
    // Test 2: Database connectivity and table status
    debugInfo.checks.database = 'testing...';
    
    // Check if assets table exists and get count
    const assetCount = await Asset.count();
    
    // Check table structure
    const tableInfo = await sequelize.getQueryInterface().describeTable('assets');
    const columnNames = Object.keys(tableInfo);
    
    debugInfo.checks.database = {
      status: 'success',
      assetCount,
      dialect: sequelize.getDialect(),
      tableExists: true,
      columnCount: columnNames.length,
      hasRequiredColumns: ['symbol', 'status', 'lastPrice'].every(col => columnNames.includes(col))
    };
  } catch (error: any) {
    debugInfo.checks.database = {
      status: 'error',
      message: error.message,
      tableExists: false
    };
  }

  try {
    // Test 3: Ticker data availability
    debugInfo.checks.ticker_data = 'testing...';
    const tickerResponse = await bingxClient.getAllTickers();
    debugInfo.checks.ticker_data = {
      status: 'success',
      responseCode: tickerResponse.code,
      dataLength: tickerResponse.data?.length || 0,
      message: tickerResponse.msg,
      endpoint: tickerResponse.source || 'unknown'
    };
  } catch (error: any) {
    debugInfo.checks.ticker_data = {
      status: 'error',
      message: error.message,
      code: error.code,
      timeout: error.code === 'ECONNABORTED'
    };
  }

  // Test 4: Database write test
  try {
    debugInfo.checks.database_write = 'testing...';
    const testSymbol = `DEBUG_TEST_${Date.now()}`;
    
    // Try to create a test asset
    await Asset.create({
      symbol: testSymbol,
      name: 'Debug Test Asset',
      baseCurrency: 'TEST',
      quoteCurrency: 'USDT',
      status: 'TRADING',
      lastPrice: 1.0,
      priceChangePercent: 0,
      volume24h: 0,
      quoteVolume24h: 0,
      highPrice24h: 1.0,
      lowPrice24h: 1.0,
      openInterest: 0,
      minQty: 0.001,
      maxQty: 1000000,
      tickSize: 0.0001,
      stepSize: 0.001,
      maxLeverage: 100,
      maintMarginRate: 0.01
    });
    
    // Clean up test asset
    await Asset.destroy({ where: { symbol: testSymbol } });
    
    debugInfo.checks.database_write = {
      status: 'success',
      message: 'Database write operations working correctly'
    };
  } catch (error: any) {
    debugInfo.checks.database_write = {
      status: 'error',
      message: error.message,
      code: error.code
    };
  }

  // Test 5: Network info
  debugInfo.network = {
    userAgent: req.headers['user-agent'],
    clientIP: req.ip,
    forwardedFor: req.headers['x-forwarded-for'],
    renderRegion: process.env.RENDER_REGION || 'unknown',
    host: req.headers.host
  };

  res.json(debugInfo);
}));

// Update coin names from external API
router.post('/update-coin-names', asyncHandler(async (_req: Request, res: Response) => {
  logger.info('🪙 Starting coin names update process...');
  
  try {
    // Get all unique symbols from database
    const assets = await Asset.findAll({
      attributes: ['symbol', 'baseCurrency'],
      group: ['symbol', 'baseCurrency']
    });
    
    if (assets.length === 0) {
      res.json({
        success: false,
        message: 'No assets found in database',
        data: {
          totalAssets: 0,
          updated: 0,
          cacheInfo: CoinInfoService.getCacheInfo()
        }
      });
      return;
    }
    
    // Extract symbols for API call
    const symbols = assets.map(asset => asset.symbol);
    logger.info(`📊 Found ${symbols.length} unique symbols to update`);
    
    // Get coin names from external API
    const coinNames = await CoinInfoService.getCoinNames(symbols);
    
    // Update assets with real coin names
    let updated = 0;
    for (const asset of assets) {
      const realName = coinNames[asset.symbol];
      if (realName && realName !== asset.symbol) {
        await Asset.update(
          { name: realName },
          { where: { symbol: asset.symbol } }
        );
        updated++;
      }
    }
    
    logger.info(`✅ Updated ${updated} asset names`);
    
    res.json({
      success: true,
      message: `Successfully updated ${updated} coin names`,
      data: {
        totalAssets: assets.length,
        updated: updated,
        cacheInfo: CoinInfoService.getCacheInfo()
      }
    });
    return;
    
  } catch (error: any) {
    logger.error('Error updating coin names:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update coin names',
      error: error.message
    });
    return;
  }
}));

export default router;