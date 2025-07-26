import { Router, Request, Response } from 'express';
import { getTradingBot } from '../trading/bot';
import { bingxClient } from '../services/bingxClient';
import Trade from '../models/Trade';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';

const router = Router();

// Get bot status
router.get('/bot/status', asyncHandler(async (req: Request, res: Response) => {
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
router.post('/bot/start', asyncHandler(async (req: Request, res: Response) => {
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
router.post('/bot/stop', asyncHandler(async (req: Request, res: Response) => {
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
router.get('/positions', asyncHandler(async (req: Request, res: Response) => {
  try {
    const positions = await bingxClient.getPositions();
    
    if (positions.code === 0 && positions.data) {
      // Filter out positions with zero amount
      const activePositions = positions.data.filter((pos: any) => 
        parseFloat(pos.positionAmt) !== 0
      );
      
      res.json({
        success: true,
        data: activePositions
      });
    } else {
      throw new AppError('Failed to fetch positions', 500);
    }
  } catch (error) {
    logger.error('Failed to get positions:', error);
    throw new AppError('Failed to fetch positions', 500);
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
        indicators: {}
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