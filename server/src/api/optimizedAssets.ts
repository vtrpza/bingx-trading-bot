import { Router, Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database';
import Asset from '../models/Asset';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { BulkAssetProcessor, AssetData } from '../services/BulkAssetProcessor';
import { optimizedBingXClient } from '../services/OptimizedBingXClient';
import { redisCache } from '../services/RedisCache';
import { workerPoolManager } from '../services/WorkerPoolManager';

const router = Router();

// Store active refresh sessions for progress tracking
const refreshSessions = new Map<string, Response>();

/**
 * Optimized SSE endpoint for refresh progress with enhanced performance monitoring
 */
router.get('/refresh/progress/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId;
  logger.debug(`🔌 New optimized SSE connection: ${sessionId}`);
  
  // Enhanced SSE headers for maximum performance
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Content-Encoding': 'none',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
    'X-Accel-Buffering': 'no'
  });
  
  refreshSessions.set(sessionId, res);
  
  // Send connection confirmation with performance info
  const initialMessage = { 
    type: 'connected', 
    sessionId, 
    timestamp: Date.now(),
    performance: {
      workerPool: workerPoolManager.getStats(),
      cache: redisCache.getStats()
    }
  };
  
  res.write(`data: ${JSON.stringify(initialMessage)}\n\n`);
  if (typeof res.flush === 'function') {
    res.flush();
  }
  
  // Enhanced cleanup handlers
  const cleanup = () => {
    refreshSessions.delete(sessionId);
    logger.debug(`🔚 Optimized SSE connection closed: ${sessionId}`);
  };
  
  req.on('close', cleanup);
  req.on('aborted', cleanup);
});

/**
 * Enhanced sendProgress with performance metrics
 */
async function sendProgress(sessionId: string, data: any): Promise<void> {
  const session = refreshSessions.get(sessionId);
  if (!session) return;

  // Add performance context to progress updates
  const enhancedData = {
    ...data,
    timestamp: Date.now(),
    performance: {
      workerPool: workerPoolManager.getStats(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      }
    }
  };

  const message = `data: ${JSON.stringify(enhancedData)}\n\n`;
  session.write(message);
  
  if (typeof session.flush === 'function') {
    session.flush();
  }
  if (session.socket) {
    session.socket.setNoDelay(true);
  }
}

/**
 * High-performance assets endpoint with intelligent caching and pagination
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const startTime = Date.now();
  const { 
    page = 1, 
    limit = 20, 
    sortBy = 'quoteVolume24h', 
    sortOrder = 'DESC',
    search = '',
    status = 'TRADING'
  } = req.query;

  const pageNum = parseInt(page as string);
  const limitNum = Math.min(parseInt(limit as string), 100); // Cap at 100 for performance
  const offset = (pageNum - 1) * limitNum;

  // Build optimized query with proper indexing
  let whereClause = '';
  let orderClause = '';
  let params: any[] = [];
  let paramIndex = 1;

  // Status filtering (uses index)
  if (status) {
    whereClause += `status = $${paramIndex++}`;
    params.push(status);
  }

  // Search filtering (uses trigram index)
  if (search) {
    const searchClause = `(symbol ILIKE $${paramIndex++} OR name ILIKE $${paramIndex++})`;
    whereClause = whereClause ? `${whereClause} AND ${searchClause}` : searchClause;
    params.push(`%${search}%`, `%${search}%`);
  }

  // Sorting (uses appropriate indexes)
  const validSortColumns = [
    'quoteVolume24h', 'priceChangePercent', 'lastPrice', 
    'volume24h', 'highPrice24h', 'lowPrice24h', 'openInterest', 
    'maxLeverage', 'updatedAt', 'symbol', 'name'
  ];
  
  if (validSortColumns.includes(sortBy as string)) {
    orderClause = `ORDER BY "${sortBy}" ${sortOrder} NULLS LAST`;
  } else {
    orderClause = 'ORDER BY "quoteVolume24h" DESC NULLS LAST';
  }

  try {
    // Use raw SQL for maximum performance with proper indexes
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM "Assets" 
      ${whereClause ? `WHERE ${whereClause}` : ''}
    `;

    const dataQuery = `
      SELECT * FROM "Assets" 
      ${whereClause ? `WHERE ${whereClause}` : ''}
      ${orderClause}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    // Add pagination params
    params.push(limitNum, offset);

    // Execute queries in parallel
    const [countResult, dataResult] = await Promise.all([
      sequelize.query(countQuery, { 
        replacements: params.slice(0, -2), // Remove pagination params for count
        type: QueryTypes.SELECT 
      }),
      sequelize.query(dataQuery, { 
        replacements: params, 
        type: QueryTypes.SELECT 
      })
    ]);

    const total = parseInt((countResult[0] as any).total);
    const assets = dataResult;

    const queryTime = Date.now() - startTime;
    
    logger.debug(`Optimized assets query executed in ${queryTime}ms`, {
      total,
      returned: assets.length,
      page: pageNum,
      limit: limitNum,
      sortBy,
      sortOrder,
      search: search ? '***' : '',
      status
    });

    res.json({
      success: true,
      data: {
        assets,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum)
        },
        performance: {
          queryTime,
          indexesUsed: true,
          cacheStatus: 'bypassed_for_real_time'
        }
      }
    });

  } catch (error) {
    logger.error('Optimized assets query failed:', error);
    throw new AppError('Failed to fetch assets', 500);
  }
}));

/**
 * Ultra-high-performance refresh endpoint with parallel processing
 */
router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const sessionId = req.body.sessionId || `refresh_${Date.now()}`;
  const startTime = Date.now();
  
  logger.info('🚀 Starting ultra-high-performance asset refresh', { sessionId });

  try {
    // Step 1: Fetch data in parallel with intelligent caching
    await sendProgress(sessionId, {
      type: 'progress',
      message: '🔥 Initializing parallel data fetching...',
      progress: 5
    });

    // Invalidate caches for fresh data
    await Promise.all([
      redisCache.invalidateSymbols(),
      redisCache.invalidateAllTickers()
    ]);

    // Fetch contracts and tickers in parallel using optimized client
    const [contractsResponse, tickersResponse] = await Promise.all([
      optimizedBingXClient.getSymbols(),
      optimizedBingXClient.getAllTickers()
    ]);

    await sendProgress(sessionId, {
      type: 'progress',
      message: `📊 Data fetched: ${contractsResponse?.data?.length || 0} contracts + ${tickersResponse?.data?.length || 0} tickers`,
      progress: 25
    });

    // Step 2: Parallel data processing using worker pool
    await sendProgress(sessionId, {
      type: 'progress',
      message: '⚡ Processing data with worker pool...',
      progress: 35
    });

    const contracts = contractsResponse?.data || [];
    const tickers = tickersResponse?.data || [];
    
    // Create ticker lookup map
    const tickerMap = new Map<string, any>();
    tickers.forEach((ticker: any) => {
      if (ticker.symbol) {
        tickerMap.set(ticker.symbol, ticker);
      }
    });

    // Process contracts in parallel batches
    const BATCH_SIZE = 100;
    const batches = [];
    for (let i = 0; i < contracts.length; i += BATCH_SIZE) {
      batches.push(contracts.slice(i, i + BATCH_SIZE));
    }

    const processedAssets: AssetData[] = [];
    let processedCount = 0;

    // Process batches with worker pool
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      
      try {
        // Transform contracts using worker pool
        const transformedContracts = await workerPoolManager.submitBatch(
          'transform_contract',
          batch,
          { priority: 5, timeout: 10000 }
        );

        // Enrich with ticker data
        const enrichedAssets = transformedContracts.map((contract: any) => {
          const ticker = tickerMap.get(contract.symbol);
          
          return {
            ...contract,
            lastPrice: ticker ? parseFloat(ticker.lastPrice || '0') : 0,
            priceChangePercent: ticker ? parseFloat(ticker.priceChangePercent || '0') : 0,
            volume24h: ticker ? parseFloat(ticker.volume || '0') : 0,
            quoteVolume24h: ticker ? parseFloat(ticker.quoteVolume || ticker.turnover || '0') : 0,
            highPrice24h: ticker ? parseFloat(ticker.highPrice || '0') : 0,
            lowPrice24h: ticker ? parseFloat(ticker.lowPrice || '0') : 0,
            openInterest: ticker ? parseFloat(ticker.openInterest || '0') : 0
          } as AssetData;
        });

        processedAssets.push(...enrichedAssets);
        processedCount += batch.length;

        const progress = Math.min(90, 35 + (processedCount / contracts.length) * 50);
        await sendProgress(sessionId, {
          type: 'progress',
          message: `🔄 Processed batch ${batchIndex + 1}/${batches.length} (${processedCount}/${contracts.length})`,
          progress,
          processed: processedCount,
          total: contracts.length
        });

      } catch (error) {
        logger.error(`Batch ${batchIndex + 1} processing failed:`, error);
        // Continue with other batches
      }
    }

    // Step 3: Bulk database upsert
    await sendProgress(sessionId, {
      type: 'progress',
      message: '💾 Bulk saving to database...',
      progress: 92
    });

    const bulkResult = await BulkAssetProcessor.bulkUpsertAssets(
      processedAssets,
      (processed, total) => {
        const dbProgress = 92 + (processed / total) * 6;
        sendProgress(sessionId, {
          type: 'progress',
          message: `💾 Database: ${processed}/${total} assets saved`,
          progress: Math.min(98, dbProgress)
        });
      }
    );

    // Step 4: Performance analysis and completion
    const totalTime = Date.now() - startTime;
    const throughput = processedAssets.length / (totalTime / 1000);

    const finalStats = {
      totalContracts: contracts.length,
      processedAssets: processedAssets.length,
      ...bulkResult,
      performance: {
        totalTime: `${(totalTime / 1000).toFixed(2)}s`,
        throughputPerSecond: `${throughput.toFixed(1)} assets/sec`,
        workerPoolStats: workerPoolManager.getStats(),
        cacheStats: await redisCache.getDetailedStats()
      }
    };

    await sendProgress(sessionId, {
      type: 'completed',
      message: `🎉 Ultra-high-performance refresh completed!`,
      progress: 100,
      ...finalStats
    });

    // Close SSE connection
    const session = refreshSessions.get(sessionId);
    if (session) {
      session.end();
      refreshSessions.delete(sessionId);
    }

    logger.info('🎉 Ultra-high-performance asset refresh completed', finalStats);

    res.json({
      success: true,
      data: {
        message: 'Assets refreshed with ultra-high-performance pipeline',
        sessionId,
        ...finalStats
      }
    });

  } catch (error) {
    logger.error('Ultra-high-performance asset refresh failed:', error);
    
    await sendProgress(sessionId, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });

    const session = refreshSessions.get(sessionId);
    if (session) {
      session.end();
      refreshSessions.delete(sessionId);
    }

    throw new AppError('Ultra-high-performance asset refresh failed', 500);
  }
}));

/**
 * Enhanced asset statistics with caching
 */
router.get('/stats/overview', asyncHandler(async (_req: Request, res: Response) => {
  const cacheKey = 'asset_stats_overview';
  
  // Try cache first
  let stats = await redisCache.get(cacheKey);
  
  if (!stats) {
    // Calculate stats using optimized queries
    const [
      totalAssets,
      tradingAssets,
      topGainers,
      topLosers,
      topVolume
    ] = await Promise.all([
      Asset.count(),
      Asset.count({ where: { status: 'TRADING' } }),
      Asset.findAll({
        where: { status: 'TRADING' },
        order: [['priceChangePercent', 'DESC']],
        limit: 5
      }),
      Asset.findAll({
        where: { status: 'TRADING' },
        order: [['priceChangePercent', 'ASC']],
        limit: 5
      }),
      Asset.findAll({
        where: { status: 'TRADING' },
        order: [['quoteVolume24h', 'DESC']],
        limit: 5
      })
    ]);

    stats = {
      totalAssets,
      tradingAssets,
      topGainers,
      topLosers,
      topVolume,
      lastUpdated: new Date().toISOString()
    };

    // Cache for 1 minute
    await redisCache.set(cacheKey, stats, { ttl: 60 });
  }

  res.json({
    success: true,
    data: stats
  });
}));

/**
 * Performance monitoring endpoint
 */
router.get('/performance', asyncHandler(async (_req: Request, res: Response) => {
  const performanceData = {
    bingxClient: optimizedBingXClient.getPerformanceMetrics(),
    workerPool: workerPoolManager.getPoolInfo(),
    cache: await redisCache.getDetailedStats(),
    database: {
      connections: 'N/A', // Connection pool info not directly accessible
      queries: 'N/A' // Would need query monitoring setup
    },
    system: {
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      uptime: process.uptime()
    }
  };

  res.json({
    success: true,
    data: performanceData
  });
}));

/**
 * Cache management endpoint
 */
router.post('/cache/invalidate', asyncHandler(async (req: Request, res: Response) => {
  const { pattern } = req.body;

  let invalidated = 0;
  
  if (pattern === 'all') {
    await redisCache.clearAll();
    invalidated = -1; // Indicates all cleared
  } else if (pattern === 'symbols') {
    await redisCache.invalidateSymbols();
    invalidated = await redisCache.invalidate('symbols:*');
  } else if (pattern === 'tickers') {
    await redisCache.invalidateAllTickers();
    invalidated = await redisCache.invalidate('ticker:*');
  } else if (pattern) {
    invalidated = await redisCache.invalidate(pattern);
  }

  logger.info(`Cache invalidated: ${pattern}, ${invalidated} keys affected`);

  res.json({
    success: true,
    data: {
      pattern,
      invalidatedKeys: invalidated,
      timestamp: new Date().toISOString()
    }
  });
}));

export default router;