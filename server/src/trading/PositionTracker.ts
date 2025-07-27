import { EventEmitter } from 'events';
import { apiRequestManager } from '../services/APIRequestManager';
import { logger } from '../utils/logger';

export interface RealTimePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  percentage: number;
  notional: number;
  leverage: number;
  marginType: string;
  isolatedMargin: number;
  isAutoAddMargin: boolean;
  positionSide: string;
  maintMargin: number;
  initialMargin: number;
  openOrderInitialMargin: number;
  maxNotional: number;
  bidNotional: number;
  askNotional: number;
  liquidationPrice: number;
  adlQuantile: number;
  updateTime: number;
  // Trading strategy fields
  averageEntryPrice: number;
  totalTrades: number;
  profitability: number;
  maxDrawdown: number;
  holdingTime: number;
  riskRewardRatio: number;
}

export interface PositionSnapshot {
  timestamp: number;
  positions: RealTimePosition[];
  totalPnl: number;
  totalNotional: number;
  marginUtilization: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface TradingStrategy {
  entryStrategy: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'SMART_ENTRY';
  entryPriceOffset: number; // percentage offset from current price
  maxSlippage: number;
  positionSizing: 'FIXED' | 'PERCENTAGE' | 'VOLATILITY_BASED' | 'KELLY_CRITERION';
  riskPerTrade: number; // percentage of account
  stopLossStrategy: 'FIXED' | 'ATR' | 'DYNAMIC' | 'TRAILING';
  takeProfitStrategy: 'FIXED' | 'SCALED' | 'DYNAMIC';
  riskRewardRatio: number;
}

export class PositionTracker extends EventEmitter {
  private positions: Map<string, RealTimePosition> = new Map();
  private snapshots: PositionSnapshot[] = [];
  private strategy: TradingStrategy;
  private isTracking: boolean = false;
  private trackingInterval: NodeJS.Timeout | null = null;

  constructor(strategy?: Partial<TradingStrategy>) {
    super();
    
    this.strategy = {
      entryStrategy: 'SMART_ENTRY',
      entryPriceOffset: 0.05, // 0.05% offset for better fill
      maxSlippage: 0.1, // 0.1% max slippage
      positionSizing: 'VOLATILITY_BASED',
      riskPerTrade: 2, // 2% risk per trade
      stopLossStrategy: 'ATR',
      takeProfitStrategy: 'SCALED',
      riskRewardRatio: 2.5,
      ...strategy
    };
  }

  /**
   * Start real-time position tracking
   */
  start(): void {
    if (this.isTracking) {
      logger.warn('PositionTracker is already running');
      return;
    }

    this.isTracking = true;
    
    // Initial position sync
    this.syncPositions();
    
    // Set up tracking interval (every 5 seconds)
    this.trackingInterval = setInterval(() => {
      this.syncPositions();
    }, 5000);

    logger.info('PositionTracker started with real-time monitoring');
  }

  /**
   * Stop position tracking
   */
  stop(): void {
    if (!this.isTracking) {
      return;
    }

    this.isTracking = false;
    
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }

    logger.info('PositionTracker stopped');
  }

  /**
   * Sync positions with BingX API and calculate enhanced metrics
   */
  private async syncPositions(): Promise<void> {
    try {
      const response = await apiRequestManager.getPositions() as any;
      
      if (response.code === 0 && response.data) {
        const newPositions = new Map<string, RealTimePosition>();
        let totalPnl = 0;
        let totalNotional = 0;

        for (const pos of response.data) {
          const size = parseFloat(pos.positionAmt || '0');
          if (size === 0) continue;

          const entryPrice = parseFloat(pos.entryPrice || pos.avgPrice || '0');
          const markPrice = parseFloat(pos.markPrice || '0');
          const unrealizedPnl = parseFloat(pos.unrealizedProfit || '0');
          const percentage = parseFloat(pos.percentage || '0');

          // Calculate enhanced metrics
          const notional = Math.abs(size * markPrice);
          const leverage = pos.leverage ? parseFloat(pos.leverage) : 1;
          
          // Calculate average entry price if this is an existing position
          const existingPosition = this.positions.get(pos.symbol);
          let averageEntryPrice = entryPrice;
          let totalTrades = 1;
          
          if (existingPosition && existingPosition.entryPrice !== entryPrice) {
            // Position size has changed, recalculate average entry
            const existingNotional = existingPosition.size * existingPosition.entryPrice;
            const newNotional = size * entryPrice;
            averageEntryPrice = (existingNotional + Math.abs(newNotional)) / Math.abs(size);
            totalTrades = existingPosition.totalTrades + 1;
          } else if (existingPosition) {
            averageEntryPrice = existingPosition.averageEntryPrice;
            totalTrades = existingPosition.totalTrades;
          }

          // Calculate profitability and risk metrics
          const profitability = entryPrice > 0 ? (unrealizedPnl / (Math.abs(size) * entryPrice)) * 100 : 0;
          const maxDrawdown = existingPosition ? Math.min(existingPosition.maxDrawdown, profitability) : profitability;
          const holdingTime = existingPosition ? Date.now() - (existingPosition.updateTime || Date.now()) : 0;

          const realTimePosition: RealTimePosition = {
            symbol: pos.symbol,
            side: size > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(size),
            entryPrice,
            markPrice,
            unrealizedPnl,
            realizedPnl: parseFloat(pos.realizedPnl || '0'),
            percentage,
            notional,
            leverage,
            marginType: pos.marginType || 'cross',
            isolatedMargin: parseFloat(pos.isolatedMargin || '0'),
            isAutoAddMargin: pos.isAutoAddMargin || false,
            positionSide: pos.positionSide || (size > 0 ? 'LONG' : 'SHORT'),
            maintMargin: parseFloat(pos.maintMargin || '0'),
            initialMargin: parseFloat(pos.initialMargin || '0'),
            openOrderInitialMargin: parseFloat(pos.openOrderInitialMargin || '0'),
            maxNotional: parseFloat(pos.maxNotional || '0'),
            bidNotional: parseFloat(pos.bidNotional || '0'),
            askNotional: parseFloat(pos.askNotional || '0'),
            liquidationPrice: parseFloat(pos.liquidationPrice || '0'),
            adlQuantile: parseFloat(pos.adlQuantile || '0'),
            updateTime: Date.now(),
            // Enhanced fields
            averageEntryPrice,
            totalTrades,
            profitability,
            maxDrawdown,
            holdingTime,
            riskRewardRatio: this.calculateRiskRewardRatio(entryPrice, markPrice, size > 0)
          };

          newPositions.set(pos.symbol, realTimePosition);
          totalPnl += unrealizedPnl;
          totalNotional += notional;

          // Emit position update if significantly changed
          const existing = this.positions.get(pos.symbol);
          if (!existing || this.hasSignificantChange(existing, realTimePosition)) {
            this.emit('positionUpdate', {
              symbol: pos.symbol,
              position: realTimePosition,
              change: existing ? this.calculatePositionChange(existing, realTimePosition) : null
            });
          }
        }

        // Check for closed positions
        for (const [symbol, oldPosition] of this.positions) {
          if (!newPositions.has(symbol)) {
            this.emit('positionClosed', {
              symbol,
              position: oldPosition,
              closedAt: Date.now()
            });
          }
        }

        // Update positions map
        this.positions = newPositions;

        // Create snapshot
        const snapshot: PositionSnapshot = {
          timestamp: Date.now(),
          positions: Array.from(newPositions.values()),
          totalPnl,
          totalNotional,
          marginUtilization: this.calculateMarginUtilization(totalNotional),
          riskLevel: this.assessRiskLevel(totalPnl, totalNotional)
        };

        this.snapshots.push(snapshot);
        
        // Keep only last 100 snapshots
        if (this.snapshots.length > 100) {
          this.snapshots = this.snapshots.slice(-100);
        }

        this.emit('snapshot', snapshot);

        if (newPositions.size > 0) {
          logger.debug(`Position sync completed: ${newPositions.size} active positions, Total PnL: ${totalPnl.toFixed(2)}`);
        }
      }
    } catch (error) {
      logger.error('Failed to sync positions:', error);
    }
  }

  /**
   * Calculate smart entry price based on strategy
   */
  calculateSmartEntryPrice(symbol: string, side: 'LONG' | 'SHORT', currentPrice: number): number {
    switch (this.strategy.entryStrategy) {
      case 'MARKET':
        return currentPrice;
        
      case 'LIMIT':
        // Place limit order slightly better than current price
        const offset = currentPrice * (this.strategy.entryPriceOffset / 100);
        return side === 'LONG' ? currentPrice - offset : currentPrice + offset;
        
      case 'SMART_ENTRY':
        // Use micro-edge strategy for better fills
        const microEdge = currentPrice * 0.001; // 0.001% micro edge
        return side === 'LONG' ? currentPrice + microEdge : currentPrice - microEdge;
        
      default:
        return currentPrice;
    }
  }

  /**
   * Calculate position size based on strategy
   */
  calculatePositionSize(accountBalance: number, entryPrice: number, stopLossPrice: number): number {
    const riskAmount = accountBalance * (this.strategy.riskPerTrade / 100);
    const priceRisk = Math.abs(entryPrice - stopLossPrice);
    
    if (priceRisk === 0) return 0;
    
    return riskAmount / priceRisk;
  }

  /**
   * Get current positions
   */
  getPositions(): RealTimePosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get position by symbol
   */
  getPosition(symbol: string): RealTimePosition | undefined {
    return this.positions.get(symbol);
  }

  /**
   * Get latest snapshot
   */
  getLatestSnapshot(): PositionSnapshot | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  /**
   * Get strategy configuration
   */
  getStrategy(): TradingStrategy {
    return { ...this.strategy };
  }

  /**
   * Update strategy
   */
  updateStrategy(newStrategy: Partial<TradingStrategy>): void {
    this.strategy = { ...this.strategy, ...newStrategy };
    logger.info('Trading strategy updated:', newStrategy);
  }

  // Private helper methods
  private hasSignificantChange(old: RealTimePosition, current: RealTimePosition): boolean {
    const priceChange = Math.abs(old.markPrice - current.markPrice) / old.markPrice;
    const pnlChange = Math.abs(old.unrealizedPnl - current.unrealizedPnl);
    
    return priceChange > 0.001 || pnlChange > 1; // 0.1% price change or $1 PnL change
  }

  private calculatePositionChange(old: RealTimePosition, current: RealTimePosition) {
    return {
      priceChange: current.markPrice - old.markPrice,
      priceChangePercent: ((current.markPrice - old.markPrice) / old.markPrice) * 100,
      pnlChange: current.unrealizedPnl - old.unrealizedPnl,
      sizeChange: current.size - old.size
    };
  }

  private calculateMarginUtilization(totalNotional: number): number {
    // This would typically use account balance, simplified for now
    return Math.min((totalNotional / 10000) * 100, 100); // Assuming 10K account
  }

  private assessRiskLevel(totalPnl: number, totalNotional: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const pnlPercent = totalNotional > 0 ? (totalPnl / totalNotional) * 100 : 0;
    
    if (pnlPercent < -10) return 'CRITICAL';
    if (pnlPercent < -5) return 'HIGH';
    if (pnlPercent < -2) return 'MEDIUM';
    return 'LOW';
  }

  private calculateRiskRewardRatio(entryPrice: number, currentPrice: number, isLong: boolean): number {
    if (entryPrice === 0) return 0;
    
    const priceMove = isLong ? currentPrice - entryPrice : entryPrice - currentPrice;
    const percentMove = (priceMove / entryPrice) * 100;
    
    return Math.abs(percentMove) / this.strategy.riskPerTrade;
  }
}