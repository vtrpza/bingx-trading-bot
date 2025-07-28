import { Router, Request, Response } from 'express';
import { bingxClient } from '../services/bingxClient';
import Asset from '../models/Asset';
import { AppError, asyncHandler } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';
import { sequelize } from '../config/database';

const router = Router();

// Helper function to get the correct like operator based on database dialect
const getLikeOperator = () => {
  return sequelize.getDialect() === 'postgres' ? Op.iLike : Op.like;
};

// Store active refresh sessions for progress tracking
const refreshSessions = new Map<string, Response>();

// SSE endpoint for refresh progress
router.get('/refresh/progress/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId;
  console.log(`🔌 Nova conexão SSE: ${sessionId}`);
  
  // Set up SSE headers - CRITICAL: Disable compression for real-time streaming
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform', // no-transform disables compression
    'Connection': 'keep-alive',
    'Content-Encoding': 'none', // Explicitly disable compression
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
    'X-Accel-Buffering': 'no' // Disable proxy buffering for real-time updates
  });
  
  // Store session
  refreshSessions.set(sessionId, res);
  console.log(`📊 SSE sessions ativas: ${refreshSessions.size}`);
  
  // Send initial connection message with flush
  const initialMessage = { type: 'connected', sessionId, timestamp: Date.now() };
  res.write(`data: ${JSON.stringify(initialMessage)}\n\n`);
  if (typeof res.flush === 'function') {
    res.flush();
  }
  console.log(`✅ Mensagem inicial SSE enviada para ${sessionId}`);
  
  // Keep-alive heartbeat to maintain connection and test real-time delivery
  const heartbeat = setInterval(() => {
    if (refreshSessions.has(sessionId)) {
      const pingMessage = { 
        type: 'heartbeat', 
        sessionId, 
        timestamp: Date.now(),
        message: '💓 Conexão ativa' 
      };
      res.write(`data: ${JSON.stringify(pingMessage)}\n\n`);
      if (typeof res.flush === 'function') {
        res.flush();
      }
    } else {
      clearInterval(heartbeat);
    }
  }, 2000); // Heartbeat every 2 seconds
  
  // Clean up on client disconnect
  req.on('close', () => {
    console.log(`🔚 Cliente SSE desconectado: ${sessionId}`);
    clearInterval(heartbeat);
    refreshSessions.delete(sessionId);
  });
  
  req.on('aborted', () => {
    console.log(`🔚 Cliente SSE abortado: ${sessionId}`);
    clearInterval(heartbeat);
    refreshSessions.delete(sessionId);
  });
});

// Helper function to send progress updates - CRITICAL: Added flush() for real-time delivery
function sendProgress(sessionId: string, data: any): Promise<void> {
  return new Promise((resolve) => {
    const session = refreshSessions.get(sessionId);
    if (session) {
      const message = `data: ${JSON.stringify(data)}\n\n`;
      console.log(`📡 Enviando SSE para ${sessionId}:`, data.type, data.message);
      session.write(message);
      
      // CRITICAL: Force immediate flush to bypass compression buffering
      if (typeof session.flush === 'function') {
        session.flush();
      }
      // Force socket to send data immediately by disabling Nagle's algorithm temporarily
      if (session.socket) {
        session.socket.setNoDelay(true);
      }
      
      // Yield to event loop to ensure message is sent
      setImmediate(resolve);
    } else {
      console.log(`⚠️ Sessão SSE ${sessionId} não encontrada nas ${refreshSessions.size} sessões ativas`);
      resolve();
    }
  });
}

// Helper function to yield control to event loop
function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
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

// Get all assets without pagination (for full data loading)
router.get('/all', asyncHandler(async (req: Request, res: Response) => {
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

// Refresh assets from BingX API
router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const sessionId = req.body.sessionId || `refresh_${Date.now()}`;
  const totalStartTime = Date.now(); // Real total time measurement
  logger.info('Refreshing assets from BingX API...', { sessionId });
  
  try {
    // Send initial progress IMEDIATAMENTE
    await sendProgress(sessionId, {
      type: 'progress',
      message: 'Iniciando busca completa de dados...',
      progress: 2,
      processed: 0,
      total: 0
    });
    
    // Yield to event loop and send quick update
    await yieldEventLoop();
    
    // Invalidate cache to ensure fresh data
    bingxClient.invalidateSymbolsCache();
    
    // STEP 1: Fetch contracts with progress updates
    await sendProgress(sessionId, {
      type: 'progress',
      message: '📋 Buscando metadados dos contratos da BingX...',
      progress: 5,
      processed: 0,
      total: 0
    });
    
    const contractsResponse = await bingxClient.getSymbols();
    
    await sendProgress(sessionId, {
      type: 'progress',
      message: `✅ ${contractsResponse?.data?.length || 0} contratos encontrados`,
      progress: 25,
      processed: 0,
      total: contractsResponse?.data?.length || 0
    });
    
    await yieldEventLoop();
    
    // STEP 2: Fetch market data with progress updates  
    await sendProgress(sessionId, {
      type: 'progress',
      message: '💰 Buscando dados de mercado em tempo real...',
      progress: 30,
      processed: 0,
      total: contractsResponse?.data?.length || 0
    });
    
    const tickersResponse = await bingxClient.getAllTickers();
    
    await sendProgress(sessionId, {
      type: 'progress',
      message: `✅ ${tickersResponse?.data?.length || 0} dados de mercado obtidos`,
      progress: 50,
      processed: 0,
      total: contractsResponse?.data?.length || 0
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
        endpoint: tickersResponse?.endpoint
      }
    });
    
    if (response.code !== 0 || !response.data) {
      await sendProgress(sessionId, {
        type: 'error',
        message: `BingX Contracts API Error: ${response.msg || 'Failed to fetch assets'}`
      });
      logger.error('BingX contracts API returned error:', {
        code: response.code,
        message: response.msg,
        data: response.data
      });
      throw new AppError(`BingX Contracts API Error: ${response.msg || 'Failed to fetch assets'}`, 500);
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
    
    // 🔍 INVESTIGAR: Verificar se há contratos duplicados
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
    
    logger.info(`🔍 ANÁLISE DE DUPLICATAS:`, {
      totalContratos: contractsToProcess.length,
      simbolosUnicos: uniqueSymbols,
      duplicatas: totalDuplicates,
      exemplosDuplicatas: duplicateSymbols.slice(0, 5)
    });
    
    if (totalDuplicates > 0) {
      logger.warn(`⚠️ ENCONTRADAS ${totalDuplicates} DUPLICATAS! Isso pode explicar a diferença.`);
    }
    
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
    
    
    // OPTIMIZED: Process assets with database operations
    const startTime = Date.now();
    const BATCH_SIZE = 500; // Bulk operations with 500 records at a time
    
    // Prepare all asset data in memory first (much faster)
    for (let i = 0; i < contractsToProcess.length; i++) {
      const contract = contractsToProcess[i];
      processed++;
      
      // Send progress updates for data preparation phase
      if (processed % 100 === 0 || processed <= 20 || processed === contractsToProcess.length) {
        const progress = Math.min(70, Math.round(55 + (processed / contractsToProcess.length) * 15));
        await sendProgress(sessionId, {
          type: 'progress',
          message: `🔄 Preparando dados: ${contract.symbol} (${processed}/${contractsToProcess.length})`,
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
      
      // FORÇAR SALVAMENTO DE TODOS - garantir que não haja valores que quebrem o banco
      assetData.symbol = assetData.symbol || `UNKNOWN_${processed}`;
      assetData.name = assetData.name || assetData.symbol;
      assetData.baseCurrency = assetData.baseCurrency || 'UNKNOWN';
      assetData.quoteCurrency = assetData.quoteCurrency || 'USDT';
      assetData.status = assetData.status || 'UNKNOWN';
      
      // Garantir que números sejam válidos
      Object.keys(assetData).forEach(key => {
        if (typeof assetData[key] === 'number' && isNaN(assetData[key])) {
          assetData[key] = 0;
        }
      });
      
      // Log first few asset data for debugging
      if (processed <= 3) {
        logger.debug(`Asset data ${processed}:`, assetData);
      }
      
      // ACEITAR TODOS OS CONTRATOS - apenas validar se tem símbolo mínimo
      if (!contract.symbol || contract.symbol.trim() === '') {
        // Criar símbolo temporário se não existir
        const tempSymbol = `UNKNOWN_${processed}_${Date.now()}`;
        logger.warn(`⚠️ Contrato sem símbolo, criando temporário: ${tempSymbol}`);
        contract.symbol = tempSymbol;
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

      // Upsert to database - GARANTIR que TODOS sejam salvos
      try {
        const [savedAsset, wasCreated] = await Asset.upsert(assetData, {
          returning: true
        });
        
        // Verificar se realmente foi salvo
        if (!savedAsset) {
          logger.error(`❌ FALHA CRÍTICA: Asset ${contract.symbol} não foi salvo no banco!`);
          skipped++;
          continue;
        }
        
        // Count status distribution APENAS para assets salvos
        if (statusCounts.hasOwnProperty(statusText)) {
          statusCounts[statusText as keyof typeof statusCounts]++;
        } else {
          statusCounts.UNKNOWN++;
        }

        if (wasCreated) {
          created++;
          if (processed <= 10) {
            logger.info(`✅ CRIADO: ${contract.symbol} → ID: ${savedAsset.id}`);
          }
        } else {
          updated++;
          if (processed <= 10) {
            logger.info(`🔄 ATUALIZADO: ${contract.symbol} → ID: ${savedAsset.id}`);
          }
        }
        
        // Log progress mais detalhado
        if ((created + updated) % 100 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const successRate = ((created + updated) / processed * 100).toFixed(1);
          logger.info(`📊 Progress: ${created + updated}/${processed} salvos (${successRate}% success rate) em ${elapsed}s`);
        }
      } catch (dbError: any) {
        logger.error(`❌ ERRO DB ao salvar ${contract.symbol}:`, {
          error: dbError.message,
          code: dbError.code,
          detail: dbError.detail,
          assetData: {
            symbol: assetData.symbol,
            name: assetData.name,
            status: assetData.status
          }
        });
        skipped++;
        // Continue processing other assets
      }
      
      // Yield to event loop after each batch to allow SSE messages to be sent
      if ((i + 1) % BATCH_SIZE === 0 && i + 1 < contractsToProcess.length) {
        await yieldEventLoop();
      }
    }
    
    const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2); // Real total time
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2); // Just processing time
    const assetsPerSecond = ((created + updated) / parseFloat(processingTime)).toFixed(1);
    const totalSaved = created + updated;
    const successRate = ((totalSaved / processed) * 100).toFixed(1);
    
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
      message: `✅ COMPLETO: ${totalSaved} contratos + preços reais (${withMarketData} enriched, ${enrichmentRate}%) em ${totalTime}s total`,
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
      totalExecutionTime: totalTime,
      processingTime: processingTime,
      performance: assetsPerSecond,
      successRate: `${successRate}%`,
      contractsLost
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
        processed,
        statusDistribution: statusCounts,
        sessionId
      }
    });
    
  } catch (error) {
    logger.error('Failed to refresh assets:', error);
    
    // Send error progress if session exists
    await sendProgress(sessionId, {
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

export default router;