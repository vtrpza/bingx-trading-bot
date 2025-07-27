import { Router, Request, Response } from 'express';
import { getTradingBot } from '../trading/bot';
import { bingxClient } from '../services/bingxClient';
import Trade from '../models/Trade';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';
import fs from 'fs';
import path from 'path';

const router = Router();

// Get bot status
router.get('/bot/status', asyncHandler(async (_req: Request, res: Response) => {
  const bot = getTradingBot();
  const status = bot.getStatus();
  
  // Get account balance
  let balance = null;
  try {
    const balanceData = await bingxClient.getBalance();
    if (balanceData.code === 0 && balanceData.data) {
      balance = balanceData.data.balance;
    }
  } catch (error) {
    logger.error('Failed to get balance:', error);
  }
  
  res.json({
    success: true,
    data: {
      ...status,
      balance,
      demoMode: process.env.DEMO_MODE === 'true'
    }
  });
}));

// Start trading bot
router.post('/bot/start', asyncHandler(async (_req: Request, res: Response) => {
  const bot = getTradingBot();
  
  if (bot.getStatus().isRunning) {
    throw new AppError('Bot is already running', 400);
  }
  
  await bot.start();
  
  res.json({
    success: true,
    data: {
      message: 'Trading bot started successfully'
    }
  });
}));

// Stop trading bot
router.post('/bot/stop', asyncHandler(async (_req: Request, res: Response) => {
  const bot = getTradingBot();
  
  if (!bot.getStatus().isRunning) {
    throw new AppError('Bot is not running', 400);
  }
  
  bot.stop();
  
  res.json({
    success: true,
    data: {
      message: 'Trading bot stopped successfully'
    }
  });
}));

// Get bot logs
router.get('/bot/logs', asyncHandler(async (req: Request, res: Response) => {
  const { limit = 100, level = 'all' } = req.query;
  
  try {
    const logDir = process.env.LOG_DIR || 'logs';
    const logFile = level === 'error' ? 'error.log' : 'combined.log';
    const logPath = path.join(logDir, logFile);
    
    if (!fs.existsSync(logPath)) {
      return res.json({
        success: true,
        data: []
      });
    }
    
    const logs = fs.readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .slice(-parseInt(limit as string))
      .map(line => {
        try {
          const logEntry = JSON.parse(line);
          return {
            timestamp: logEntry.timestamp,
            level: logEntry.level,
            message: logEntry.message,
            service: logEntry.service
          };
        } catch {
          return {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: line,
            service: 'bingx-trading-bot'
          };
        }
      })
      .reverse();
    
    res.json({
      success: true,
      data: logs
    });
  } catch (error) {
    logger.error('Failed to read logs:', error);
    res.json({
      success: true,
      data: []
    });
  }
}));

// Update bot configuration
router.put('/bot/config', asyncHandler(async (req: Request, res: Response) => {
  const bot = getTradingBot();
  const config = req.body;
  
  // Validate config
  const allowedFields = [
    'maxConcurrentTrades',
    'defaultPositionSize',
    'scanInterval',
    'stopLossPercent',
    'takeProfitPercent',
    'trailingStopPercent',
    'minVolumeUSDT'
  ];
  
  const updates: any = {};
  for (const field of allowedFields) {
    if (config[field] !== undefined) {
      updates[field] = config[field];
    }
  }
  
  bot.updateConfig(updates);
  
  res.json({
    success: true,
    data: {
      message: 'Bot configuration updated',
      config: updates
    }
  });
}));

// Get active positions
router.get('/positions', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const positions = await bingxClient.getPositions();
    
    logger.info('Positions API response:', { 
      code: positions?.code, 
      dataLength: positions?.data?.length,
      demoMode: process.env.DEMO_MODE 
    });
    
    if (positions.code === 0) {
      // Handle empty positions array
      const positionsData = positions.data || [];
      
      // Filter out positions with zero amount
      const activePositions = positionsData.filter((pos: any) => {
        const amount = parseFloat(pos.positionAmt || '0');
        return !isNaN(amount) && amount !== 0;
      });
      
      res.json({
        success: true,
        data: activePositions
      });
    } else {
      logger.error('BingX API returned error:', {
        code: positions.code,
        message: positions.msg,
        demoMode: process.env.DEMO_MODE
      });
      
      // In demo mode, return empty positions if API fails
      if (process.env.DEMO_MODE === 'true') {
        logger.warn('Demo mode: Returning empty positions due to API error');
        res.json({
          success: true,
          data: []
        });
      } else {
        throw new AppError(`BingX API Error: ${positions.msg || 'Unknown error'}`, 500);
      }
    }
  } catch (error) {
    logger.error('Failed to get positions:', {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      demoMode: process.env.DEMO_MODE
    });
    
    // In demo mode, gracefully handle API failures
    if (process.env.DEMO_MODE === 'true') {
      logger.warn('Demo mode: Returning empty positions due to fetch error');
      res.json({
        success: true,
        data: []
      });
    } else {
      throw new AppError('Failed to fetch positions from BingX', 500);
    }
  }
}));

// Get open orders
router.get('/orders/open', asyncHandler(async (req: Request, res: Response) => {
  const { symbol } = req.query;
  
  try {
    const orders = await bingxClient.getOpenOrders(symbol as string);
    
    if (orders.code === 0) {
      res.json({
        success: true,
        data: orders.data || []
      });
    } else {
      throw new AppError('Failed to fetch open orders', 500);
    }
  } catch (error) {
    logger.error('Failed to get open orders:', error);
    throw new AppError('Failed to fetch open orders', 500);
  }
}));

// Get trade history
router.get('/trades/history', asyncHandler(async (req: Request, res: Response) => {
  const { 
    page = 1, 
    limit = 20, 
    symbol,
    status,
    startDate,
    endDate
  } = req.query;

  const pageNum = parseInt(page as string);
  const limitNum = parseInt(limit as string);
  const offset = (pageNum - 1) * limitNum;

  // Build where clause
  const where: any = {};
  
  if (symbol) {
    where.symbol = symbol;
  }
  
  if (status) {
    where.status = status;
  }
  
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) {
      where.createdAt[Op.gte] = new Date(startDate as string);
    }
    if (endDate) {
      where.createdAt[Op.lte] = new Date(endDate as string);
    }
  }

  // Get trades from database
  const { count, rows } = await Trade.findAndCountAll({
    where,
    limit: limitNum,
    offset,
    order: [['createdAt', 'DESC']]
  });

  res.json({
    success: true,
    data: {
      trades: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum)
      }
    }
  });
}));

// Get trading statistics
router.get('/stats', asyncHandler(async (req: Request, res: Response) => {
  const { period = '24h' } = req.query;
  
  // Calculate date range
  let startDate = new Date();
  switch (period) {
    case '24h':
      startDate.setHours(startDate.getHours() - 24);
      break;
    case '7d':
      startDate.setDate(startDate.getDate() - 7);
      break;
    case '30d':
      startDate.setDate(startDate.getDate() - 30);
      break;
    case 'all':
      startDate = new Date(0);
      break;
  }
  
  // Get trades within period
  const trades = await Trade.findAll({
    where: {
      createdAt: { [Op.gte]: startDate },
      status: 'FILLED'
    }
  });
  
  // Calculate statistics
  const totalTrades = trades.length;
  const winningTrades = trades.filter(t => t.realizedPnl > 0).length;
  const losingTrades = trades.filter(t => t.realizedPnl < 0).length;
  const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl.toString()), 0);
  const totalVolume = trades.reduce((sum, t) => sum + (parseFloat(t.executedQty.toString()) * parseFloat(t.avgPrice.toString())), 0);
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  
  // Get best and worst trades
  const bestTrade = trades.reduce((best, current) => 
    (!best || parseFloat(current.realizedPnl.toString()) > parseFloat(best.realizedPnl.toString())) ? current : best
  , null as Trade | null);
  
  const worstTrade = trades.reduce((worst, current) => 
    (!worst || parseFloat(current.realizedPnl.toString()) < parseFloat(worst.realizedPnl.toString())) ? current : worst
  , null as Trade | null);
  
  res.json({
    success: true,
    data: {
      period,
      totalTrades,
      winningTrades,
      losingTrades,
      winRate: winRate.toFixed(2),
      totalPnl: totalPnl.toFixed(2),
      totalVolume: totalVolume.toFixed(2),
      averagePnl: totalTrades > 0 ? (totalPnl / totalTrades).toFixed(2) : '0',
      bestTrade: bestTrade ? {
        symbol: bestTrade.symbol,
        pnl: bestTrade.realizedPnl,
        date: bestTrade.executedAt
      } : null,
      worstTrade: worstTrade ? {
        symbol: worstTrade.symbol,
        pnl: worstTrade.realizedPnl,
        date: worstTrade.executedAt
      } : null
    }
  });
}));

// Place manual order
router.post('/orders', asyncHandler(async (req: Request, res: Response) => {
  const orderData = req.body;
  
  // Validate required fields
  if (!orderData.symbol || !orderData.side || !orderData.quantity) {
    throw new AppError('Missing required fields: symbol, side, quantity', 400);
  }
  
  try {
    const order = await bingxClient.placeOrder(orderData);
    
    if (order.code === 0 && order.data) {
      // Save to database
      await Trade.create({
        orderId: order.data.orderId,
        symbol: orderData.symbol,
        side: orderData.side,
        positionSide: orderData.positionSide || (orderData.side === 'BUY' ? 'LONG' : 'SHORT'),
        type: orderData.type || 'MARKET',
        status: 'NEW',
        quantity: orderData.quantity,
        price: orderData.price || 0,
        stopLossPrice: orderData.stopLoss,
        takeProfitPrice: orderData.takeProfit,
        signalStrength: 0,
        signalReason: 'Manual order',
        indicators: {},
        commissionAsset: 'USDT',
        commission: 0,
        executedQty: 0,
        avgPrice: 0,
        realizedPnl: 0
      });
      
      res.json({
        success: true,
        data: order.data
      });
    } else {
      throw new AppError(order.msg || 'Failed to place order', 400);
    }
  } catch (error) {
    logger.error('Failed to place order:', error);
    throw new AppError('Failed to place order', 500);
  }
}));

// Cancel order
router.delete('/orders/:orderId', asyncHandler(async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { symbol } = req.query;
  
  if (!symbol) {
    throw new AppError('Symbol is required', 400);
  }
  
  try {
    const result = await bingxClient.cancelOrder(symbol as string, orderId);
    
    if (result.code === 0) {
      // Update database
      await Trade.update(
        { status: 'CANCELED' },
        { where: { orderId } }
      );
      
      res.json({
        success: true,
        data: {
          message: 'Order canceled successfully'
        }
      });
    } else {
      throw new AppError(result.msg || 'Failed to cancel order', 400);
    }
  } catch (error) {
    logger.error('Failed to cancel order:', error);
    throw new AppError('Failed to cancel order', 500);
  }
}));

export default router;