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

// Interface para dados de candles com indicadores
interface CandleWithIndicators {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma1: number | null; // MM1 (Média Móvel 1)
  center: number | null; // Center (Média Móvel mais longa)
  rsi: number | null;
}

// Função auxiliar para calcular RSI
function calculateRSI(prices: number[], period: number = 14): number | null {
  if (prices.length < period + 1) return null;
  
  let gains = 0;
  let losses = 0;
  
  // Calcular ganhos e perdas iniciais
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Função auxiliar para calcular média móvel simples
function calculateSMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null;
  const sum = prices.slice(0, period).reduce((a, b) => a + b, 0);
  return sum / period;
}

const router = Router();

// Get bot status (unified endpoint - checks both bots)
router.get('/bot/status', asyncHandler(async (_req: Request, res: Response) => {
  // Try parallel bot first (preferred)
  try {
    const parallelBot = getParallelTradingBot();
    const status = await parallelBot.getStatus();
    
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
      demoMode: process.env.DEMO_MODE,
      sampleData: positions?.data?.slice(0, 2) // Log first 2 positions for debugging
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
        .map((pos: any) => {
          // Only sanitize if the values are actually invalid, preserve original values
          const sanitized = { ...pos };
          
          // Log original data for debugging
          if (parseFloat(pos.positionAmt) !== 0) {
            logger.debug('Processing position:', {
              symbol: pos.symbol,
              positionAmt: pos.positionAmt,
              entryPrice: pos.entryPrice,
              markPrice: pos.markPrice,
              unrealizedProfit: pos.unrealizedProfit
            });
          }
          
          return sanitized;
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
    const status = await parallelBot.getStatus();
    
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

// Get pipeline status - novo endpoint para visualização do pipeline
router.get('/parallel-bot/pipeline', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const bot = getParallelTradingBot();
    const status = await bot.getStatus();
    const metrics = bot.getMetrics();
    
    // Estruturar dados para o frontend baseado nas métricas disponíveis
    const pipelineStatus = {
      signalWorkers: {
        active: Math.floor((metrics.systemMetrics?.workerUtilization || 0) / 20),
        total: status.config.signalWorkers?.maxWorkers || 5,
        processing: metrics.signalMetrics?.queuedSignals || 0,
        utilization: metrics.systemMetrics?.workerUtilization || 0
      },
      signalQueue: {
        size: metrics.signalMetrics?.queuedSignals || 0,
        processing: Math.max(0, (metrics.signalMetrics?.processedSignals || 0) - (metrics.signalMetrics?.totalGenerated || 0)),
        priority: {
          high: Math.floor((metrics.signalMetrics?.queuedSignals || 0) * 0.3),
          medium: Math.floor((metrics.signalMetrics?.queuedSignals || 0) * 0.5),
          low: Math.floor((metrics.signalMetrics?.queuedSignals || 0) * 0.2)
        }
      },
      tradeExecutors: {
        active: Math.min(status.config.tradeExecutors?.maxExecutors || 3, status.activePositions?.length || 0),
        total: status.config.tradeExecutors?.maxExecutors || 3,
        executing: Math.min(2, status.activePositions?.length || 0),
        utilization: Math.min(100, ((status.activePositions?.length || 0) / (status.config.tradeExecutors?.maxExecutors || 3)) * 100)
      },
      activePositions: status.activePositions?.length || 0,
      throughput: {
        signalsPerMinute: (metrics.scanningMetrics?.symbolsPerSecond || 0) * 60,
        tradesPerMinute: metrics.executionMetrics?.totalExecuted || 0,
        successRate: metrics.executionMetrics?.successRate || 0
      }
    };
    
    res.json({
      success: true,
      data: pipelineStatus
    });
  } catch (error) {
    logger.error('Erro no endpoint pipeline:', error);
    // Retorna dados padrão em caso de erro
    res.json({
      success: true,
      data: {
        signalWorkers: { active: 0, total: 5, processing: 0, utilization: 0 },
        signalQueue: { size: 0, processing: 0, priority: { high: 0, medium: 0, low: 0 } },
        tradeExecutors: { active: 0, total: 3, executing: 0, utilization: 0 },
        activePositions: 0,
        throughput: { signalsPerMinute: 0, tradesPerMinute: 0, successRate: 0 }
      }
    });
  }
}));

// Get signal tracking - rastreamento de sinais específicos
router.get('/parallel-bot/signal-tracking', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { symbol, limit = 10 } = req.query;
    
    // Buscar eventos de atividade relacionados a sinais
    const bot = getParallelTradingBot();
    const activityEvents = bot.getActivityEvents() || [];
    
    // Filtrar e estruturar dados de rastreamento
    let signalEvents = activityEvents
      .filter((event: any) => {
        if (symbol && event.symbol !== symbol) return false;
        return ['signal_generated', 'signal_queued', 'signal_processing', 'trade_executed', 'signal_rejected'].includes(event.type);
      })
      .slice(0, parseInt(limit as string));
    
    // Agrupar eventos por símbolo para criar timeline
    const signalTracking = signalEvents.reduce((acc: any[], event: any) => {
      const existing = acc.find(s => s.symbol === event.symbol);
      
      if (!existing) {
        acc.push({
          id: `signal-${event.symbol}-${event.timestamp}`,
          symbol: event.symbol,
          action: event.metadata?.action || 'HOLD',
          strength: event.metadata?.strength || 0,
          status: mapEventTypeToStatus(event.type),
          stages: {
            analyzed: true,
            queued: ['signal_queued', 'signal_processing', 'trade_executed'].includes(event.type),
            executed: ['signal_processing', 'trade_executed'].includes(event.type),
            positionOpened: event.type === 'trade_executed'
          },
          timeline: {
            created: event.timestamp,
            [mapEventTypeToTimelineKey(event.type)]: event.timestamp
          },
          details: event.metadata || {}
        });
      } else {
        // Atualizar status e timeline existente
        existing.status = mapEventTypeToStatus(event.type);
        existing.timeline[mapEventTypeToTimelineKey(event.type)] = event.timestamp;
        if (event.type === 'signal_queued') existing.stages.queued = true;
        if (event.type === 'signal_processing') existing.stages.executed = true;
        if (event.type === 'trade_executed') existing.stages.positionOpened = true;
      }
      
      return acc;
    }, []);
    
    res.json({
      success: true,
      data: signalTracking
    });
  } catch (error) {
    logger.error('Erro no endpoint signal-tracking:', error);
    res.json({
      success: true,
      data: [] // Retorna array vazio em caso de erro
    });
  }
}));

// Helper functions para mapeamento
function mapEventTypeToStatus(eventType: string): string {
  switch (eventType) {
    case 'signal_generated': return 'analyzing';
    case 'signal_queued': return 'queued';
    case 'signal_processing': return 'executing';
    case 'trade_executed': return 'completed';
    case 'signal_rejected': return 'rejected';
    default: return 'analyzing';
  }
}

function mapEventTypeToTimelineKey(eventType: string): string {
  switch (eventType) {
    case 'signal_generated': return 'analyzed';
    case 'signal_queued': return 'queued';
    case 'signal_processing': return 'executionStarted';
    case 'trade_executed': return 'executionCompleted';
    default: return 'timestamp';
  }
}

// Get parallel bot status
router.get('/parallel-bot/status', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const status = await parallelBot.getStatus();
  
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
  const status = await parallelBot.getStatus();
  
  if (status.isRunning) {
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
  
  const startedStatus = await parallelBot.getStatus();
  res.json({
    success: true,
    message: 'Parallel trading bot started successfully',
    data: {
      config: startedStatus.config,
      rateLimitStatus: globalRateLimiter.getStatus()
    }
  });
}));

// Stop parallel trading bot
router.post('/parallel-bot/stop', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const status = await parallelBot.getStatus();
  
  if (!status.isRunning) {
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
  
  const updatedStatus = await parallelBot.getStatus();
  res.json({
    success: true,
    message: 'Configuration updated successfully',
    data: updatedStatus.config
  });
}));

// Force signal scan
router.post('/parallel-bot/scan', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const { symbols } = req.body;
  const status = await parallelBot.getStatus();
  
  if (!status.isRunning) {
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

// Signal close position
router.post('/parallel-bot/positions/:symbol/close', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const rawSymbol = req.params.symbol;
  const symbol = validateAndFormatSymbol(rawSymbol);
  const { reason = 'Manual close', percentage = 100 } = req.body;
  const status = await parallelBot.getStatus();
  
  if (!status.isRunning) {
    throw new AppError('Parallel bot is not running', 400);
  }
  
  // Validate percentage for partial close
  if (percentage < 1 || percentage > 100) {
    throw new AppError('Close percentage must be between 1 and 100', 400);
  }
  
  await parallelBot.signalClosePosition(symbol, { reason, percentage });
  
  res.json({
    success: true,
    message: `Close signal sent for position: ${symbol} (${percentage}%)`,
    data: { symbol, percentage, reason }
  });
}));

// Signal close all positions
router.post('/parallel-bot/positions/close-all', asyncHandler(async (_req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const status = await parallelBot.getStatus();
  
  if (!status.isRunning) {
    throw new AppError('Parallel bot is not running', 400);
  }
  
  await parallelBot.signalCloseAllPositions();
  
  res.json({
    success: true,
    message: 'Emergency close signal sent for all positions'
  });
}));

// Update position stop-loss/take-profit
router.post('/parallel-bot/positions/:symbol/update', asyncHandler(async (req: Request, res: Response) => {
  const parallelBot = getParallelTradingBot();
  const rawSymbol = req.params.symbol;
  const symbol = validateAndFormatSymbol(rawSymbol);
  const { stopLoss, takeProfit } = req.body;
  const status = await parallelBot.getStatus();
  
  if (!status.isRunning) {
    throw new AppError('Parallel bot is not running', 400);
  }
  
  // Validate stop-loss and take-profit values
  if (stopLoss !== undefined && (typeof stopLoss !== 'number' || stopLoss <= 0)) {
    throw new AppError('Stop-loss must be a positive number', 400);
  }
  
  if (takeProfit !== undefined && (typeof takeProfit !== 'number' || takeProfit <= 0)) {
    throw new AppError('Take-profit must be a positive number', 400);
  }
  
  await parallelBot.updatePositionLevels(symbol, { stopLoss, takeProfit });
  
  res.json({
    success: true,
    message: `Position levels updated for ${symbol}`,
    data: { symbol, stopLoss, takeProfit }
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
  const status = await parallelBot.getStatus();
  
  if (!status.isRunning) {
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
  const botStatus = await parallelBot.getStatus();
  
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
        isRunning: botStatus.isRunning,
        architecture: 'parallel',
        immediateExecution: botStatus.config.immediateExecution
      }
    }
  });
}));

// Endpoint para buscar candles com indicadores técnicos
router.get('/candles/:symbol', asyncHandler(async (req: Request, res: Response) => {
  const { symbol } = req.params;
  const { interval = '5m', limit = 50 } = req.query;
  
  try {
    // Buscar dados dos candles da API da BingX
    const candleResponse = await bingxClient.getKlines(
      symbol,
      interval as string,
      parseInt(limit as string)
    );
    
    // Extrair dados dos candles da resposta
    const candleData = candleResponse.code === 0 ? candleResponse.data : null;

    if (!candleData || !Array.isArray(candleData)) {
      throw new AppError('Invalid candle data received', 400);
    }

    // Processar dados e calcular indicadores
    const processedCandles: CandleWithIndicators[] = [];
    const closePrices: number[] = [];
    
    // Primeiro, coletar todos os preços de fechamento para cálculos
    candleData.forEach((candle: any) => {
      closePrices.push(parseFloat(candle.close));
    });

    // Processar cada candle com indicadores
    candleData.forEach((candle: any, index: number) => {
      const timestamp = parseInt(candle.time);
      const open = parseFloat(candle.open);
      const high = parseFloat(candle.high);
      const low = parseFloat(candle.low);
      const close = parseFloat(candle.close);
      const volume = parseFloat(candle.volume);

      // Calcular MM1 (média móvel de 9 períodos)
      const ma1 = calculateSMA(closePrices.slice(index), 9);
      
      // Calcular Center (média móvel de 21 períodos)
      const center = calculateSMA(closePrices.slice(index), 21);
      
      // Calcular RSI (14 períodos)
      const rsi = calculateRSI(closePrices.slice(index).reverse(), 14);

      processedCandles.push({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        ma1,
        center,
        rsi
      });
    });

    res.json({
      success: true,
      data: processedCandles
    });
  } catch (error) {
    logger.error(`Erro ao buscar candles para ${symbol}:`, error);
    res.json({
      success: false,
      data: [],
      error: 'Falha ao buscar dados de candles'
    });
  }
}));

// Endpoint para buscar posições abertas
router.get('/positions', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const bot = getParallelTradingBot();
    const positions = bot.getManagedPositions();
    
    res.json({
      success: true,
      data: positions
    });
  } catch (error) {
    logger.error('Erro ao buscar posições:', error);
    res.json({
      success: false,
      data: [],
      error: 'Falha ao buscar posições'
    });
  }
}));

// Endpoint para executar trade
router.post('/execute', asyncHandler(async (req: Request, res: Response) => {
  const { symbol, side, type, quantity, stopLoss } = req.body;
  
  try {
    // Validar dados de entrada
    if (!symbol || !side || !type || !quantity) {
      throw new AppError('Dados de trade incompletos', 400);
    }

    if (!['BUY', 'SELL'].includes(side)) {
      throw new AppError('Side deve ser BUY ou SELL', 400);
    }

    if (!['MARKET', 'LIMIT'].includes(type)) {
      throw new AppError('Type deve ser MARKET ou LIMIT', 400);
    }

    // Verificar se o bot está rodando
    const bot = getParallelTradingBot();
    const status = await bot.getStatus();
    
    if (!status.isRunning) {
      throw new AppError('Bot não está executando', 400);
    }

    // Executar a ordem via BingX API
    const orderParams: any = {
      symbol,
      side,
      type,
      quantity: parseFloat(quantity)
    };

    if (type === 'MARKET') {
      // Para ordem a mercado, usar a API do BingX diretamente
      const result = await bingxClient.placeOrder(orderParams);
      
      // Se stop loss foi especificado, criar ordem de stop loss
      if (stopLoss && result.code === 0 && result.data?.orderId) {
        try {
          const stopLossOrder = await bingxClient.placeOrder({
            symbol,
            side: side === 'BUY' ? 'SELL' : 'BUY',
            type: 'STOP_MARKET',
            quantity: parseFloat(quantity),
            stopPrice: parseFloat(stopLoss)
          });
          
          logger.info(`Stop loss criado: ${stopLossOrder.data?.orderId}`);
        } catch (stopError) {
          logger.error('Erro ao criar stop loss:', stopError);
        }
      }

      res.json({
        success: true,
        data: result,
        message: `Trade executado: ${side} ${symbol}`
      });
    } else {
      throw new AppError('Apenas ordens MARKET são suportadas atualmente', 400);
    }
  } catch (error) {
    logger.error('Erro ao executar trade:', error);
    res.status(500).json({
      success: false,
      error: error instanceof AppError ? error.message : 'Erro interno do servidor'
    });
  }
}));

export default router;