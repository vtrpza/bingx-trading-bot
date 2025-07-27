import { Router, Request, Response } from 'express';
import { getTradingBot } from '../trading/bot';
import { getParallelTradingBot } from '../trading/ParallelTradingBot';
import { PerformanceMonitor } from '../trading/PerformanceMonitor';
import { balancedConfig, highFrequencyConfig, conservativeConfig, ConfigurationOptimizer } from '../trading/ParallelBotConfiguration';
import { bingxClient } from '../services/bingxClient';
import { apiRequestManager } from '../services/APIRequestManager';
import { globalRateLimiter } from '../services/rateLimiter';
import Trade from '../models/Trade';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';
import fs from 'fs';
import path from 'path';

const router = Router();

// Get bot status (unified endpoint - checks both bots)
router.get('/bot/status', asyncHandler(async (_req: Request, res: Response) => {
  // Try parallel bot first (preferred)
  try {
    const parallelBot = getParallelTradingBot();
    const status = parallelBot.getStatus();
    
    // Get account balance using APIRequestManager
    let balance = null;
    try {
      const balanceData: any = await apiRequestManager.getBalance();
      if (balanceData.code === 0 && balanceData.data) {
        balance = balanceData.data.balance;
      }
    } catch (error) {
      logger.error('Failed to get balance:', error);
    }
    
    // Get position manager data
    const managedPositions = parallelBot.getManagedPositions();
    const positionMetrics = parallelBot.getPositionMetrics();
    
    res.json({
      success: true,
      data: {
        ...status,
        balance,
        demoMode: process.env.DEMO_MODE === 'true',
        architecture: 'parallel',
        managedPositions: managedPositions.length,
        positionMetrics,
        immediateExecution: status.config.immediateExecution
      }
    });
  } catch (error) {
    // Fallback to legacy bot if parallel bot fails
    logger.warn('Parallel bot not available, falling back to legacy bot');
    const bot = getTradingBot();
    const status = bot.getStatus();
    
    let balance = null;
    try {
      const balanceData: any = await apiRequestManager.getBalance();
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
        demoMode: process.env.DEMO_MODE === 'true',
        architecture: 'legacy'
      }
    });
  }
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
    
    return res.json({
      success: true,
      data: logs
    });
  } catch (error) {
    logger.error('Failed to read logs:', error);
    return res.json({
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
    const positions = await apiRequestManager.getPositions() as any;
    
    logger.info('Positions API response:', { 
      code: positions?.code, 
      dataLength: positions?.data?.length,
      demoMode: process.env.DEMO_MODE 
    });
    
    if (positions.code === 0) {
      // Handle empty positions array
      const positionsData = positions.data || [];
      
      // Filter out positions with zero amount and sanitize data
      const activePositions = positionsData
        .filter((pos: any) => {
          const amount = parseFloat(pos.positionAmt || '0');
          return !isNaN(amount) && amount !== 0;
        })
        .map((pos: any) => ({
          ...pos,
          // Ensure numeric fields are valid numbers or default to '0'
          positionAmt: isNaN(parseFloat(pos.positionAmt)) ? '0' : pos.positionAmt,
          entryPrice: isNaN(parseFloat(pos.entryPrice)) ? '0' : pos.entryPrice,
          markPrice: isNaN(parseFloat(pos.markPrice)) ? '0' : pos.markPrice,
          unrealizedProfit: isNaN(parseFloat(pos.unrealizedProfit)) ? '0' : pos.unrealizedProfit,
          percentage: isNaN(parseFloat(pos.percentage)) ? '0' : pos.percentage,
          notional: isNaN(parseFloat(pos.notional)) ? '0' : pos.notional,
          isolatedMargin: isNaN(parseFloat(pos.isolatedMargin)) ? '0' : pos.isolatedMargin
        }));
      
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
    const orders = await apiRequestManager.getOpenOrders(symbol as string) as any;
    
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

// Get trading statistics (enhanced with position manager data)
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
  
  // Calculate basic statistics
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
  
  // Try to get enhanced data from parallel bot
  let positionData = null;
  let botStatus = null;
  try {
    const parallelBot = getParallelTradingBot();
    const positionMetrics = parallelBot.getPositionMetrics();
    const currentPositions = parallelBot.getManagedPositions();
    const status = parallelBot.getStatus();
    
    positionData = {
      currentActive: currentPositions.length,
      metrics: positionMetrics
    };
    
    botStatus = {
      isRunning: status.isRunning,
      architecture: 'parallel',
      immediateExecution: status.config.immediateExecution
    };
  } catch (error) {
    // Fallback to basic bot data
    try {
      const bot = getTradingBot();
      const status = bot.getStatus();
      botStatus = {
        isRunning: status.isRunning,
        architecture: 'legacy'
      };
    } catch (fallbackError) {
      logger.error('Failed to get bot status:', fallbackError);
    }
  }
  
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
      } : null,
      // Enhanced data
      positions: positionData,
      bot: botStatus
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

// Get trading flow state (compatibility endpoint for both bot architectures)
router.get('/bot/flow-state', asyncHandler(async (_req: Request, res: Response) => {
  // Use parallel bot as the primary implementation
  const parallelBot = getParallelTradingBot();
  const flowState = parallelBot.getFlowState();
  
  res.json({
    success: true,
    data: flowState
  });
}));

// Get activity events (compatibility endpoint)
router.get('/bot/activity-events', asyncHandler(async (req: Request, res: Response) => {
  const { limit = 50 } = req.query;
  // Use parallel bot as the primary implementation
  const parallelBot = getParallelTradingBot();
  const events = parallelBot.getActivityEvents(parseInt(limit as string));
  
  res.json({
    success: true,
    data: events
  });
}));

// Get process metrics (compatibility endpoint)
router.get('/bot/process-metrics', asyncHandler(async (_req: Request, res: Response) => {
  // Use parallel bot as the primary implementation
  const parallelBot = getParallelTradingBot();
  const metrics = parallelBot.getProcessMetrics();
  
  res.json({
    success: true,
    data: metrics
  });
}));

// === PARALLEL TRADING BOT ROUTES ===

// Global performance monitor instance
let performanceMonitor: PerformanceMonitor | null = null;

// Get parallel bot status
router.get('/parallel-bot/status', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const status = parallelBot.getStatus();
  
  // Get account balance using APIRequestManager
  let balance = null;
  try {
    const balanceData: any = await apiRequestManager.getBalance();
    if (balanceData.code === 0 && balanceData.data) {
      balance = balanceData.data.balance;
    }
  } catch (error) {
    logger.error('Failed to get balance:', error);
  }
  
  // Get position manager data
  const managedPositions = parallelBot.getManagedPositions();
  const positionMetrics = parallelBot.getPositionMetrics();
  
  res.json({
    success: true,
    data: {
      ...status,
      balance,
      demoMode: process.env.DEMO_MODE === 'true',
      architecture: 'parallel',
      managedPositions: managedPositions.length,
      positionMetrics
    }
  });
}));

// Start parallel trading bot
router.post('/parallel-bot/start', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  
  if (parallelBot.getStatus().isRunning) {
    throw new AppError('Parallel bot is already running', 400);
  }
  
  // Use balanced configuration with system optimization
  const config = balancedConfig;
  const systemOptimized = ConfigurationOptimizer.optimizeForSystem();
  parallelBot.updateConfig({ ...config, ...systemOptimized });
  
  await parallelBot.start();
  
  // Start performance monitoring
  if (!performanceMonitor) {
    performanceMonitor = new PerformanceMonitor(parallelBot);
    performanceMonitor.start();
  }
  
  res.json({
    success: true,
    message: 'Parallel trading bot started successfully',
    data: {
      config: parallelBot.getStatus().config,
      rateLimitStatus: globalRateLimiter.getStatus()
    }
  });
}));

// Stop parallel trading bot
router.post('/parallel-bot/stop', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  
  if (!parallelBot.getStatus().isRunning) {
    throw new AppError('Parallel bot is not running', 400);
  }
  
  parallelBot.stop();
  
  // Stop performance monitoring
  if (performanceMonitor) {
    performanceMonitor.stop();
    performanceMonitor = null;
  }
  
  res.json({
    success: true,
    message: 'Parallel trading bot stopped successfully'
  });
}));

// Get parallel bot metrics
router.get('/parallel-bot/metrics', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const metrics = parallelBot.getMetrics();
  
  res.json({
    success: true,
    data: metrics
  });
}));

// Get performance monitoring data
router.get('/parallel-bot/performance', asyncHandler(async (req: Request, res: Response) => {
  if (!performanceMonitor) {
    throw new AppError('Performance monitoring not active', 400);
  }
  
  const { minutes = 30 } = req.query;
  const summary = performanceMonitor.getPerformanceSummary(Number(minutes));
  const trends = performanceMonitor.getTrendAnalysis(Number(minutes));
  const bottlenecks = performanceMonitor.getBottleneckAnalysis();
  
  res.json({
    success: true,
    data: {
      summary,
      trends,
      bottlenecks,
      alerts: performanceMonitor.getActiveAlerts(),
      latestSnapshot: performanceMonitor.getLatestSnapshot()
    }
  });
}));

// Get parallel bot activity events
router.get('/parallel-bot/activity', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const { limit = 50 } = req.query;
  const events = parallelBot.getActivityEvents(Number(limit));
  
  res.json({
    success: true,
    data: events
  });
}));

// Update parallel bot configuration
router.put('/parallel-bot/config', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const { config } = req.body;
  
  if (!config) {
    throw new AppError('Configuration is required', 400);
  }
  
  // Validate configuration
  if (config.maxConcurrentTrades && (config.maxConcurrentTrades < 1 || config.maxConcurrentTrades > 20)) {
    throw new AppError('maxConcurrentTrades must be between 1 and 20', 400);
  }
  
  parallelBot.updateConfig(config);
  
  res.json({
    success: true,
    message: 'Configuration updated successfully',
    data: parallelBot.getStatus().config
  });
}));

// Force signal scan
router.post('/parallel-bot/scan', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const { symbols } = req.body;
  
  if (!parallelBot.getStatus().isRunning) {
    throw new AppError('Parallel bot is not running', 400);
  }
  
  parallelBot.forceSignalScan(symbols);
  
  res.json({
    success: true,
    message: `Forced scan initiated for ${symbols ? symbols.length : 'all'} symbols`
  });
}));

// Clear signal queue
router.post('/parallel-bot/clear-queue', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  
  parallelBot.clearSignalQueue();
  
  res.json({
    success: true,
    message: 'Signal queue cleared'
  });
}));

// Invalidate cache
router.post('/parallel-bot/invalidate-cache', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const { symbol } = req.body;
  
  parallelBot.invalidateCache(symbol);
  
  res.json({
    success: true,
    message: `Cache invalidated${symbol ? ` for ${symbol}` : ''}`
  });
}));

// Get configuration presets
router.get('/parallel-bot/presets', asyncHandler(async (_req: Request, res: Response) => {
  const systemOptimized = ConfigurationOptimizer.optimizeForSystem();
  
  res.json({
    success: true,
    data: {
      balanced: { ...balancedConfig, ...systemOptimized },
      aggressive: { ...highFrequencyConfig, ...systemOptimized },
      conservative: { ...conservativeConfig, ...systemOptimized },
      systemOptimized
    }
  });
}));

// Performance alerts
router.get('/parallel-bot/alerts', asyncHandler(async (_req: Request, res: Response) => {
  if (!performanceMonitor) {
    res.json({
      success: true,
      data: []
    });
    return;
  }
  
  const alerts = performanceMonitor.getAllAlerts(50);
  
  res.json({
    success: true,
    data: alerts
  });
}));

// Resolve performance alert
router.post('/parallel-bot/alerts/:alertId/resolve', asyncHandler(async (req: Request, res: Response) => {
  if (!performanceMonitor) {
    throw new AppError('Performance monitoring not active', 400);
  }
  
  const { alertId } = req.params;
  const resolved = performanceMonitor.resolveAlert(alertId);
  
  if (!resolved) {
    throw new AppError('Alert not found', 404);
  }
  
  res.json({
    success: true,
    message: 'Alert resolved successfully'
  });
}));

// Parallel bot real-time data (WebSocket endpoint info)
router.get('/parallel-bot/realtime-info', asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      endpoints: {
        signals: '/ws/parallel-signals',
        metrics: '/ws/parallel-metrics', 
        alerts: '/ws/parallel-alerts'
      },
      eventTypes: [
        'signalGenerated',
        'tradeExecuted',
        'positionClosed',
        'performanceUpdate',
        'alert',
        'configChanged'
      ]
    }
  });
}));

// Get rate limit status
router.get('/parallel-bot/rate-limit', asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: globalRateLimiter.getStatus()
  });
}));

// Get blacklisted symbols
router.get('/parallel-bot/blacklist', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const blacklistedSymbols = parallelBot.getBlacklistedSymbols();
  
  res.json({
    success: true,
    data: blacklistedSymbols
  });
}));

// Clear symbol blacklist
router.post('/parallel-bot/blacklist/clear', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  parallelBot.clearSymbolBlacklist();
  
  res.json({
    success: true,
    data: {
      message: 'Symbol blacklist cleared successfully'
    }
  });
}));

// Reset circuit breaker
router.post('/parallel-bot/circuit-breaker/reset', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  parallelBot.resetCircuitBreaker();
  
  res.json({
    success: true,
    data: {
      message: 'Circuit breaker reset successfully'
    }
  });
}));

// === POSITION MANAGER ROUTES ===

// Get managed positions
router.get('/parallel-bot/positions', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const managedPositions = parallelBot.getManagedPositions();
  
  res.json({
    success: true,
    data: managedPositions
  });
}));

// Get position metrics
router.get('/parallel-bot/position-metrics', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const metrics = parallelBot.getPositionMetrics();
  
  res.json({
    success: true,
    data: metrics
  });
}));

// Symbol validation helper
function validateAndFormatSymbol(symbol: string): string {
  if (!symbol) {
    throw new AppError('Symbol is required', 400);
  }
  
  // Convert to uppercase and normalize format
  const normalizedSymbol = symbol.toUpperCase().replace(/[\/\\]/g, '-');
  
  // Remove any trailing -VST-USDT, -VST-USDC patterns first
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

// Signal close position
router.post('/parallel-bot/positions/:symbol/close', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const rawSymbol = req.params.symbol;
  const symbol = validateAndFormatSymbol(rawSymbol);
  
  if (!parallelBot.getStatus().isRunning) {
    throw new AppError('Parallel bot is not running', 400);
  }
  
  await parallelBot.signalClosePosition(symbol);
  
  res.json({
    success: true,
    message: `Close signal sent for position: ${symbol}`
  });
}));

// Signal close all positions
router.post('/parallel-bot/positions/close-all', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  
  if (!parallelBot.getStatus().isRunning) {
    throw new AppError('Parallel bot is not running', 400);
  }
  
  await parallelBot.signalCloseAllPositions();
  
  res.json({
    success: true,
    message: 'Emergency close signal sent for all positions'
  });
}));

// Confirm position closed (for external closures)
router.post('/parallel-bot/positions/:symbol/confirm-closed', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const rawSymbol = req.params.symbol;
  const symbol = validateAndFormatSymbol(rawSymbol);
  const { actualPnl } = req.body;
  
  await parallelBot.confirmPositionClosed(symbol, actualPnl);
  
  res.json({
    success: true,
    message: `Position closure confirmed for: ${symbol}`
  });
}));

// Execute signal immediately for specific symbol
router.post('/parallel-bot/execute-immediate/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const rawSymbol = req.params.symbol;
  const symbol = validateAndFormatSymbol(rawSymbol);
  
  if (!parallelBot.getStatus().isRunning) {
    throw new AppError('Parallel bot is not running', 400);
  }
  
  const taskId = await parallelBot.executeSignalImmediately(symbol);
  
  res.json({
    success: true,
    data: {
      taskId,
      message: `Immediate execution ${taskId ? 'initiated' : 'failed'} for ${symbol}`
    }
  });
}));

// Toggle immediate execution mode
router.post('/parallel-bot/immediate-execution', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const { enabled } = req.body;
  
  if (typeof enabled !== 'boolean') {
    throw new AppError('enabled must be a boolean value', 400);
  }
  
  parallelBot.setImmediateExecutionMode(enabled);
  
  res.json({
    success: true,
    message: `Immediate execution mode ${enabled ? 'enabled' : 'disabled'}`
  });
}));

// Enhanced trading stats with position manager data
router.get('/parallel-bot/enhanced-stats', asyncHandler(async (req: Request, res: Response) => {
  const { period = '24h' } = req.query;
  
  // Get basic stats (same logic as /stats)
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
  
  const trades = await Trade.findAll({
    where: {
      createdAt: { [Op.gte]: startDate },
      status: 'FILLED'
    }
  });
  
  const totalTrades = trades.length;
  const winningTrades = trades.filter(t => t.realizedPnl > 0).length;
  const losingTrades = trades.filter(t => t.realizedPnl < 0).length;
  const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl.toString()), 0);
  const totalVolume = trades.reduce((sum, t) => sum + (parseFloat(t.executedQty.toString()) * parseFloat(t.avgPrice.toString())), 0);
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  
  // Get position manager metrics
  const parallelBot = getParallelTradingBot();
  const positionMetrics = parallelBot.getPositionMetrics();
  const currentPositions = parallelBot.getManagedPositions();
  
  res.json({
    success: true,
    data: {
      period,
      trading: {
        totalTrades,
        winningTrades,
        losingTrades,
        winRate: winRate.toFixed(2),
        totalPnl: totalPnl.toFixed(2),
        totalVolume: totalVolume.toFixed(2),
        averagePnl: totalTrades > 0 ? (totalPnl / totalTrades).toFixed(2) : '0'
      },
      positions: {
        current: currentPositions.length,
        metrics: positionMetrics
      },
      bot: {
        isRunning: parallelBot.getStatus().isRunning,
        architecture: 'parallel',
        immediateExecution: parallelBot.getStatus().config.immediateExecution
      }
    }
  });
}));

export default router;