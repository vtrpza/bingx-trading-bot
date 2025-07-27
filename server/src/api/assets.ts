import { Router, Request, Response } from 'express';
import { bingxClient } from '../services/bingxClient';
import Asset from '../models/Asset';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';

const router = Router();

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
router.post('/refresh', asyncHandler(async (_req: Request, res: Response) => {
  logger.info('Refreshing assets from BingX API...');
  
  try {
    // Get all contracts from BingX
    const response = await bingxClient.getSymbols();
    
    logger.info('BingX getSymbols response:', {
      code: response?.code,
      dataLength: response?.data?.length,
      sampleData: response?.data?.slice(0, 2) // Show first 2 items for debugging
    });
    
    if (response.code !== 0 || !response.data) {
      logger.error('BingX API returned error:', {
        code: response.code,
        message: response.msg,
        data: response.data
      });
      throw new AppError(`BingX API Error: ${response.msg || 'Failed to fetch assets'}`, 500);
    }
    
    const contracts = response.data;
    let created = 0;
    let updated = 0;
    let processed = 0;
    let skipped = 0;
    
    logger.info(`Processing ${contracts.length} contracts from BingX...`);
    
    // Process each contract
    for (const contract of contracts) {
      processed++;
      
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
      
      // Get ticker data for volume and price info
      try {
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
        logger.warn(`Failed to get ticker for ${contract.symbol}:`, error);
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
      totalContracts: contracts.length,
      processed,
      skipped,
      created,
      updated,
      perpetualContracts: processed - skipped
    });
    
    res.json({
      success: true,
      data: {
        message: 'Assets refreshed successfully',
        created,
        updated,
        total: contracts.length,
        processed: processed - skipped,
        skipped
      }
    });
    
  } catch (error) {
    logger.error('Failed to refresh assets:', error);
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