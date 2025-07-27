import { Router, Request, Response } from 'express';
import { bingxClient } from '../services/bingxClient';
import Asset from '../models/Asset';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';

const router = Router();

// Store active refresh sessions for progress tracking
const refreshSessions = new Map<string, Response>();

// SSE endpoint for refresh progress
router.get('/refresh/progress/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId;
  
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
  
  // Store session
  refreshSessions.set(sessionId, res);
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);
  
  // Clean up on client disconnect
  req.on('close', () => {
    refreshSessions.delete(sessionId);
  });
});

// Helper function to send progress updates
function sendProgress(sessionId: string, data: any) {
  const session = refreshSessions.get(sessionId);
  if (session) {
    session.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

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
    where[Op.or] = [
      { symbol: { [Op.iLike]: `%${search}%` } },
      { name: { [Op.iLike]: `%${search}%` } }
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

// Get single asset details
router.get('/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const { symbol } = req.params;
  
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

// Refresh assets from BingX API
router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const sessionId = req.body.sessionId || `refresh_${Date.now()}`;
  logger.info('Refreshing assets from BingX API...', { sessionId });
  
  try {
    // Send initial progress
    sendProgress(sessionId, {
      type: 'progress',
      message: 'Fetching contracts from BingX API...',
      progress: 0,
      processed: 0,
      total: 0
    });

    // Get all contracts from BingX
    const response = await bingxClient.getSymbols();
    
    logger.info('BingX getSymbols response:', {
      code: response?.code,
      dataLength: response?.data?.length,
      sampleData: response?.data?.slice(0, 2) // Show first 2 items for debugging
    });
    
    if (response.code !== 0 || !response.data) {
      sendProgress(sessionId, {
        type: 'error',
        message: `BingX API Error: ${response.msg || 'Failed to fetch assets'}`
      });
      logger.error('BingX API returned error:', {
        code: response.code,
        message: response.msg,
        data: response.data
      });
      throw new AppError(`BingX API Error: ${response.msg || 'Failed to fetch assets'}`, 500);
    }
    
   
    const contractsToProcess = response.data;
    
    // Send progress with total count
    sendProgress(sessionId, {
      type: 'progress',
      message: `Processing ${contractsToProcess.length} contracts...`,
      progress: 5,
      processed: 0,
      total: contractsToProcess.length
    });
    
    let created = 0;
    let updated = 0;
    let processed = 0;
    let skipped = 0;
    
    
    // Process each contract with rate limiting (100 requests/10 seconds = 10 requests/second max)
    let tickerRequests = 0;
    const maxRequestsPerSecond = 8; // Conservative limit below 10/sec
    let lastRequestTime = Date.now();
    
    for (const contract of contractsToProcess) {
      processed++;
      
      // Send progress updates every 10 items or for first few
      if (processed % 10 === 0 || processed <= 5) {
        const progress = Math.min(95, Math.round(10 + (processed / contractsToProcess.length) * 85));
        sendProgress(sessionId, {
          type: 'progress',
          message: `Processing ${contract.symbol}... (${processed}/${contractsToProcess.length})`,
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
      
      // Log contract structure for debugging
      if (processed <= 5) {
        logger.debug(`Contract ${processed} structure:`, {
          symbol: contract.symbol,
          status: contract.status,
          contractType: contract.contractType,
          contractId: contract.contractId,
          asset: contract.asset,
          currency: contract.currency,
          hasContractType: 'contractType' in contract
        });
      }
      
      // BingX futures contracts don't have contractType field
      // Instead they have status=1 (active) and are all perpetual futures
      // Skip if not active trading status
      if (contract.status !== 1) {
        skipped++;
        if (processed <= 5) {
          logger.debug(`Skipping inactive contract: ${contract.symbol} (status: ${contract.status})`);
        }
        continue;
      }
      
      const assetData: any = {
        symbol: contract.symbol,
        name: contract.displayName || contract.symbol,
        baseCurrency: contract.asset,           // BTC, ETH, etc.
        quoteCurrency: contract.currency,       // USDT
        status: contract.status === 1 ? 'TRADING' : 'SUSPEND',
        minQty: parseFloat(contract.tradeMinQuantity || contract.size || 0),
        maxQty: parseFloat(contract.maxQty || 999999999),
        tickSize: Math.pow(10, -contract.pricePrecision),     // Convert precision to tick size
        stepSize: Math.pow(10, -contract.quantityPrecision),  // Convert precision to step size
        maxLeverage: parseInt(contract.maxLeverage || 100),   // Default max leverage
        maintMarginRate: parseFloat(contract.feeRate || 0),
        // Initialize missing required fields
        lastPrice: 0,
        priceChangePercent: 0,
        volume24h: 0,
        quoteVolume24h: 0,
        highPrice24h: 0,
        lowPrice24h: 0,
        openInterest: 0
      };
      
      // Log first few asset data for debugging
      if (processed <= 3) {
        logger.debug(`Asset data ${processed}:`, assetData);
      }
      
      // Get ticker data for volume and price info with rate limiting
      try {
        // Rate limiting: max 8 requests per second
        tickerRequests++;
        if (tickerRequests >= maxRequestsPerSecond) {
          const timeElapsed = Date.now() - lastRequestTime;
          if (timeElapsed < 1000) {
            const delay = 1000 - timeElapsed;
            logger.debug(`Rate limiting: waiting ${delay}ms before next batch`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
          tickerRequests = 0;
          lastRequestTime = Date.now();
        }
        
        const ticker = await bingxClient.getTicker(contract.symbol);
        if (ticker.code === 0 && ticker.data) {
          assetData.lastPrice = parseFloat(ticker.data.lastPrice);
          assetData.priceChangePercent = parseFloat(ticker.data.priceChangePercent);
          assetData.volume24h = parseFloat(ticker.data.volume);
          assetData.quoteVolume24h = parseFloat(ticker.data.quoteVolume);
          assetData.highPrice24h = parseFloat(ticker.data.highPrice);
          assetData.lowPrice24h = parseFloat(ticker.data.lowPrice);
          assetData.openInterest = parseFloat(ticker.data.openInterest || 0);
        }
      } catch (error) {
        // Check if it's a rate limit error
        if (error instanceof Error && (error.message.includes('1015') || error.message.includes('rate limit'))) {
          logger.warn(`Rate limit hit for ${contract.symbol}, waiting 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          tickerRequests = 0;
          lastRequestTime = Date.now();
        } else {
          logger.warn(`Failed to get ticker for ${contract.symbol}:`, error);
        }
        // Continue processing other contracts even if ticker fails
      }
      
      // Upsert to database
      try {
        const [_asset, wasCreated] = await Asset.upsert(assetData, {
          returning: true
        });
        
        if (wasCreated) {
          created++;
        } else {
          updated++;
        }
        
        // Log progress every 50 assets
        if ((created + updated) % 50 === 0) {
          logger.info(`Progress: ${created + updated} assets processed (${created} created, ${updated} updated)`);
        }
      } catch (dbError) {
        logger.error(`Failed to upsert asset ${contract.symbol}:`, dbError);
        // Continue processing other assets
      }
    }
    
    logger.info(`Assets refresh completed:`, {
      totalContracts: contractsToProcess.length,
      processedContracts: contractsToProcess.length,
      processed,
      skipped,
      created,
      updated,
      perpetualContracts: processed - skipped
    });
    
    // Send final progress
    sendProgress(sessionId, {
      type: 'completed',
      message: 'Assets refresh completed successfully!',
      progress: 100,
      processed,
      total: contractsToProcess.length,
      created,
      updated,
      skipped: processed - skipped
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
        message: 'Assets refreshed successfully',
        created,
        updated,
        total: contractsToProcess.length,
        processed: processed - skipped,
        skipped,
        sessionId
      }
    });
    
  } catch (error) {
    logger.error('Failed to refresh assets:', error);
    
    // Send error progress if session exists
    sendProgress(sessionId, {
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error during refresh'
    });
    
    // Close SSE connection
    const session = refreshSessions.get(sessionId);
    if (session) {
      session.end();
      refreshSessions.delete(sessionId);
    }
    
    throw new AppError('Failed to refresh assets', 500);
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

export default router;