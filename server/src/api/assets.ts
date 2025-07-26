import { Router } from 'express';
import { bingxClient } from '../services/bingxClient';
import Asset from '../models/Asset';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';

const router = Router();

// Get all assets with pagination, sorting, and filtering
router.get('/', asyncHandler(async (req, res) => {
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
router.get('/:symbol', asyncHandler(async (req, res) => {
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
router.post('/refresh', asyncHandler(async (req, res) => {
  logger.info('Refreshing assets from BingX API...');
  
  try {
    // Get all contracts from BingX
    const response = await bingxClient.getSymbols();
    
    if (response.code !== 0 || !response.data) {
      throw new AppError('Failed to fetch assets from BingX', 500);
    }
    
    const contracts = response.data;
    let created = 0;
    let updated = 0;
    
    // Process each contract
    for (const contract of contracts) {
      if (contract.contractType !== 'PERPETUAL') {
        continue;
      }
      
      const assetData = {
        symbol: contract.symbol,
        name: contract.symbol,
        baseCurrency: contract.currency,
        quoteCurrency: contract.asset,
        status: contract.status,
        minQty: parseFloat(contract.minQty || 0),
        maxQty: parseFloat(contract.maxQty || 0),
        tickSize: parseFloat(contract.pricePrecision || 0),
        stepSize: parseFloat(contract.quantityPrecision || 0),
        maxLeverage: parseInt(contract.maxLongLeverage || 1),
        maintMarginRate: parseFloat(contract.maintMarginPercent || 0)
      };
      
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
      const [asset, wasCreated] = await Asset.upsert(assetData, {
        returning: true
      });
      
      if (wasCreated) {
        created++;
      } else {
        updated++;
      }
    }
    
    logger.info(`Assets refresh completed: ${created} created, ${updated} updated`);
    
    res.json({
      success: true,
      data: {
        message: 'Assets refreshed successfully',
        created,
        updated,
        total: contracts.length
      }
    });
    
  } catch (error) {
    logger.error('Failed to refresh assets:', error);
    throw new AppError('Failed to refresh assets', 500);
  }
}));

// Get asset statistics
router.get('/stats/overview', asyncHandler(async (req, res) => {
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