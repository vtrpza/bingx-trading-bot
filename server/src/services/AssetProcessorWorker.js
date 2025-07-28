const { parentPort, workerData } = require('worker_threads');

/**
 * Asset processing worker for parallel data transformation
 * Handles CPU-intensive tasks like data validation, normalization, and enrichment
 */

class AssetProcessorWorker {
  constructor(workerId) {
    this.workerId = workerId;
    this.processedTasks = 0;
    
    console.log(`Asset processor worker ${workerId} initialized`);
  }

  /**
   * Process a single task based on type
   */
  async processTask(task) {
    const startTime = Date.now();
    
    try {
      let result;
      
      switch (task.type) {
        case 'validate_asset':
          result = await this.validateAsset(task.data);
          break;
          
        case 'enrich_asset':
          result = await this.enrichAsset(task.data);
          break;
          
        case 'transform_contract':
          result = await this.transformContract(task.data);
          break;
          
        case 'calculate_metrics':
          result = await this.calculateMetrics(task.data);
          break;
          
        case 'normalize_ticker':
          result = await this.normalizeTicker(task.data);
          break;
          
        case 'batch_process':
          result = await this.batchProcess(task.data);
          break;
          
        default:
          throw new Error(`Unknown task type: ${task.type}`);
      }
      
      this.processedTasks++;
      
      return {
        taskId: task.id,
        success: true,
        data: result,
        processingTime: Date.now() - startTime,
        workerId: this.workerId
      };
      
    } catch (error) {
      return {
        taskId: task.id,
        success: false,
        error: error.message,
        processingTime: Date.now() - startTime,
        workerId: this.workerId
      };
    }
  }

  /**
   * Validate asset data structure and values
   */
  async validateAsset(assetData) {
    // Simulate CPU-intensive validation
    if (!assetData || typeof assetData !== 'object') {
      throw new Error('Invalid asset data structure');
    }

    const requiredFields = ['symbol', 'name', 'status'];
    const errors = [];

    for (const field of requiredFields) {
      if (!assetData[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // Validate numeric fields
    const numericFields = [
      'lastPrice', 'priceChangePercent', 'volume24h', 'quoteVolume24h',
      'highPrice24h', 'lowPrice24h', 'openInterest', 'minQty', 'maxQty',
      'tickSize', 'stepSize', 'maxLeverage', 'maintMarginRate'
    ];

    for (const field of numericFields) {
      if (assetData[field] !== undefined) {
        const value = Number(assetData[field]);
        if (isNaN(value) || !isFinite(value)) {
          errors.push(`Invalid numeric value for ${field}: ${assetData[field]}`);
        }
      }
    }

    // Validate symbol format
    if (assetData.symbol && !/^[A-Z0-9-]+$/.test(assetData.symbol)) {
      errors.push(`Invalid symbol format: ${assetData.symbol}`);
    }

    // Validate status
    const validStatuses = ['TRADING', 'SUSPENDED', 'DELISTED', 'MAINTENANCE', 'UNKNOWN'];
    if (assetData.status && !validStatuses.includes(assetData.status)) {
      errors.push(`Invalid status: ${assetData.status}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      processedFields: Object.keys(assetData).length
    };
  }

  /**
   * Enrich asset data with calculated values
   */
  async enrichAsset(assetData) {
    // Simulate CPU-intensive enrichment calculations
    const enriched = { ...assetData };

    // Calculate derived metrics
    if (enriched.lastPrice && enriched.volume24h) {
      enriched.volumeValue24h = enriched.lastPrice * enriched.volume24h;
    }

    // Calculate price change in absolute terms
    if (enriched.lastPrice && enriched.priceChangePercent) {
      const changeRatio = enriched.priceChangePercent / 100;
      enriched.priceChange24h = enriched.lastPrice * changeRatio / (1 + changeRatio);
    }

    // Calculate spread percentage
    if (enriched.highPrice24h && enriched.lowPrice24h && enriched.lowPrice24h > 0) {
      enriched.spreadPercent = ((enriched.highPrice24h - enriched.lowPrice24h) / enriched.lowPrice24h) * 100;
    }

    // Calculate volume rank (simplified)
    enriched.volumeRank = this.calculateVolumeRank(enriched.quoteVolume24h || 0);

    // Risk assessment
    enriched.riskLevel = this.calculateRiskLevel(enriched);

    // Trading activity score
    enriched.activityScore = this.calculateActivityScore(enriched);

    return enriched;
  }

  /**
   * Transform raw contract data from BingX API
   */
  async transformContract(contractData) {
    // Simulate transformation of BingX contract format to internal format
    if (!contractData) {
      throw new Error('No contract data provided');
    }

    const transformed = {
      symbol: this.normalizeSymbol(contractData.symbol || contractData.contractName),
      name: contractData.displayName || contractData.name || contractData.symbol,
      baseCurrency: this.extractBaseCurrency(contractData),
      quoteCurrency: this.extractQuoteCurrency(contractData),
      status: this.normalizeStatus(contractData.status),
      
      // Contract specifications
      minQty: this.parseNumber(contractData.tradeMinQuantity || contractData.size || contractData.minQty, 0),
      maxQty: this.parseNumber(contractData.maxQty || contractData.maxQuantity, 999999999),
      tickSize: this.calculateTickSize(contractData.pricePrecision),
      stepSize: this.calculateStepSize(contractData.quantityPrecision),
      maxLeverage: this.parseNumber(contractData.maxLeverage, 100),
      maintMarginRate: this.parseNumber(contractData.feeRate || contractData.maintMarginRate, 0),
      
      // Initialize market data fields
      lastPrice: 0,
      priceChangePercent: 0,
      volume24h: 0,
      quoteVolume24h: 0,
      highPrice24h: 0,
      lowPrice24h: 0,
      openInterest: 0,
      
      // Metadata
      _source: 'bingx_contract',
      _transformedAt: new Date().toISOString()
    };

    return transformed;
  }

  /**
   * Calculate various metrics for asset analysis
   */
  async calculateMetrics(data) {
    const { assets, timeframe } = data;
    
    if (!Array.isArray(assets)) {
      throw new Error('Assets must be an array');
    }

    // Simulate complex metric calculations
    const metrics = {
      totalAssets: assets.length,
      tradingAssets: assets.filter(a => a.status === 'TRADING').length,
      totalVolume: assets.reduce((sum, a) => sum + (a.quoteVolume24h || 0), 0),
      avgVolume: 0,
      topGainers: [],
      topLosers: [],
      topVolume: [],
      marketCap: 0,
      volatilityIndex: 0
    };

    if (metrics.totalAssets > 0) {
      metrics.avgVolume = metrics.totalVolume / metrics.totalAssets;
    }

    // Calculate top performers (CPU intensive sorting)
    const tradingAssets = assets.filter(a => a.status === 'TRADING' && a.priceChangePercent !== undefined);
    
    metrics.topGainers = tradingAssets
      .sort((a, b) => (b.priceChangePercent || 0) - (a.priceChangePercent || 0))
      .slice(0, 10);
      
    metrics.topLosers = tradingAssets
      .sort((a, b) => (a.priceChangePercent || 0) - (b.priceChangePercent || 0))
      .slice(0, 10);
      
    metrics.topVolume = tradingAssets
      .sort((a, b) => (b.quoteVolume24h || 0) - (a.quoteVolume24h || 0))
      .slice(0, 10);

    // Calculate volatility index
    if (tradingAssets.length > 0) {
      const changes = tradingAssets.map(a => Math.abs(a.priceChangePercent || 0));
      metrics.volatilityIndex = changes.reduce((sum, change) => sum + change, 0) / changes.length;
    }

    return metrics;
  }

  /**
   * Normalize ticker data from various API responses
   */
  async normalizeTicker(tickerData) {
    if (!tickerData) {
      throw new Error('No ticker data provided');
    }

    // Handle different ticker response formats from BingX
    const normalized = {
      symbol: tickerData.symbol,
      lastPrice: this.parseNumber(tickerData.lastPrice || tickerData.close || tickerData.price, 0),
      priceChangePercent: this.parseNumber(tickerData.priceChangePercent || tickerData.change, 0),
      volume24h: this.parseNumber(tickerData.volume || tickerData.vol, 0),
      quoteVolume24h: this.parseNumber(tickerData.quoteVolume || tickerData.turnover || tickerData.quoteVol, 0),
      highPrice24h: this.parseNumber(tickerData.highPrice || tickerData.high, 0),
      lowPrice24h: this.parseNumber(tickerData.lowPrice || tickerData.low, 0),
      openInterest: this.parseNumber(tickerData.openInterest || tickerData.oi, 0),
      
      // Calculated fields
      priceChange24h: 0,
      timestamp: Date.now(),
      _normalized: true
    };

    // Calculate absolute price change
    if (normalized.lastPrice && normalized.priceChangePercent) {
      const changeRatio = normalized.priceChangePercent / 100;
      normalized.priceChange24h = normalized.lastPrice * changeRatio / (1 + changeRatio);
    }

    return normalized;
  }

  /**
   * Process multiple items in batch
   */
  async batchProcess(batchData) {
    const { items, operation } = batchData;
    
    if (!Array.isArray(items)) {
      throw new Error('Batch items must be an array');
    }

    const results = [];
    const errors = [];

    for (let i = 0; i < items.length; i++) {
      try {
        let result;
        
        switch (operation) {
          case 'validate':
            result = await this.validateAsset(items[i]);
            break;
          case 'enrich':
            result = await this.enrichAsset(items[i]);
            break;
          case 'transform':
            result = await this.transformContract(items[i]);
            break;
          case 'normalize':
            result = await this.normalizeTicker(items[i]);
            break;
          default:
            throw new Error(`Unknown batch operation: ${operation}`);
        }
        
        results.push({ index: i, success: true, data: result });
      } catch (error) {
        errors.push({ index: i, error: error.message });
        results.push({ index: i, success: false, error: error.message });
      }
    }

    return {
      totalItems: items.length,
      successCount: results.filter(r => r.success).length,
      errorCount: errors.length,
      results,
      errors
    };
  }

  // Utility methods

  normalizeSymbol(symbol) {
    if (!symbol) return 'UNKNOWN';
    return String(symbol).toUpperCase().trim();
  }

  extractBaseCurrency(contract) {
    if (contract.asset) return contract.asset;
    if (contract.baseAsset) return contract.baseAsset;
    
    // Try to extract from symbol
    const symbol = contract.symbol || contract.contractName || '';
    const match = symbol.match(/^([A-Z0-9]+)[-_]?[A-Z0-9]+$/);
    return match ? match[1] : 'UNKNOWN';
  }

  extractQuoteCurrency(contract) {
    if (contract.currency) return contract.currency;
    if (contract.quoteAsset) return contract.quoteAsset;
    
    // Try to extract from symbol
    const symbol = contract.symbol || contract.contractName || '';
    const match = symbol.match(/^[A-Z0-9]+[-_]?([A-Z0-9]+)$/);
    return match ? match[1] : 'USDT';
  }

  normalizeStatus(status) {
    if (status === undefined || status === null) return 'UNKNOWN';
    
    const statusCode = typeof status === 'string' ? parseInt(status) : status;
    
    switch (statusCode) {
      case 1: return 'TRADING';
      case 0: return 'SUSPENDED';
      case 2: return 'DELISTED';
      case 3: return 'MAINTENANCE';
      default: return 'UNKNOWN';
    }
  }

  parseNumber(value, defaultValue = 0) {
    const num = Number(value);
    return isNaN(num) || !isFinite(num) ? defaultValue : num;
  }

  calculateTickSize(pricePrecision) {
    if (pricePrecision && !isNaN(pricePrecision)) {
      return Math.pow(10, -pricePrecision);
    }
    return 0.0001; // Default
  }

  calculateStepSize(quantityPrecision) {
    if (quantityPrecision && !isNaN(quantityPrecision)) {
      return Math.pow(10, -quantityPrecision);
    }
    return 0.001; // Default
  }

  calculateVolumeRank(volume) {
    // Simplified volume ranking
    if (volume >= 1000000) return 'high';
    if (volume >= 100000) return 'medium';
    if (volume >= 10000) return 'low';
    return 'minimal';
  }

  calculateRiskLevel(asset) {
    let risk = 0;
    
    // Price volatility
    if (asset.spreadPercent > 10) risk += 2;
    else if (asset.spreadPercent > 5) risk += 1;
    
    // Volume
    if (asset.quoteVolume24h < 10000) risk += 2;
    else if (asset.quoteVolume24h < 100000) risk += 1;
    
    // Leverage
    if (asset.maxLeverage > 100) risk += 1;
    
    if (risk >= 4) return 'high';
    if (risk >= 2) return 'medium';
    return 'low';
  }

  calculateActivityScore(asset) {
    let score = 0;
    
    // Volume contribution
    if (asset.quoteVolume24h > 1000000) score += 40;
    else if (asset.quoteVolume24h > 100000) score += 20;
    else if (asset.quoteVolume24h > 10000) score += 10;
    
    // Price movement
    const absChange = Math.abs(asset.priceChangePercent || 0);
    if (absChange > 10) score += 30;
    else if (absChange > 5) score += 20;
    else if (absChange > 1) score += 10;
    
    // Open interest
    if (asset.openInterest > 1000000) score += 30;
    else if (asset.openInterest > 100000) score += 15;
    
    return Math.min(100, score);
  }
}

// Initialize worker
if (parentPort) {
  const worker = new AssetProcessorWorker(workerData.workerId);
  
  parentPort.on('message', async (task) => {
    try {
      const result = await worker.processTask(task);
      parentPort.postMessage(result);
    } catch (error) {
      parentPort.postMessage({
        taskId: task.id,
        success: false,
        error: error.message,
        processingTime: 0,
        workerId: workerData.workerId
      });
    }
  });
  
  // Handle worker shutdown gracefully
  process.on('SIGTERM', () => {
    console.log(`Worker ${workerData.workerId} shutting down gracefully`);
    process.exit(0);
  });
}