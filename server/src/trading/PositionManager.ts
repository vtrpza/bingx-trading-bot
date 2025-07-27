import { EventEmitter } from 'events';
import { apiRequestManager } from '../services/APIRequestManager';
import { bingxClient } from '../services/bingxClient';
import { wsManager } from '../services/websocket';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import Trade from '../models/Trade';

export interface ManagedPosition {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  orderId: string;
  tradeId?: string;
  unrealizedPnl: number;
  status: 'ACTIVE' | 'CLOSING' | 'CLOSED';
  createdAt: number;
  lastUpdate: number;
}

export interface PositionManagerConfig {
  enabled: boolean;
  monitoringInterval: number; // ms
  priceCheckThreshold: number; // % price movement to trigger check
  emergencyCloseThreshold: number; // % loss to force close
  trailingStopEnabled: boolean;
  trailingStopPercent: number;
  maxPositionAge: number; // max time to hold position (ms)
  riskManagement: {
    maxDrawdownPercent: number;
    maxDailyLoss: number;
    forceCloseOnError: boolean;
  };
}

export interface PositionMetrics {
  totalPositions: number;
  activePositions: number;
  closedPositions: number;
  totalPnL: number;
  winRate: number;
  avgHoldTime: number;
  stopLossTriggered: number;
  takeProfitTriggered: number;
  manuallyClosedCount: number;
}

export class PositionManager extends EventEmitter {
  private positions: Map<string, ManagedPosition> = new Map();
  private config: PositionManagerConfig;
  private isRunning: boolean = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private metrics: PositionMetrics = {
    totalPositions: 0,
    activePositions: 0,
    closedPositions: 0,
    totalPnL: 0,
    winRate: 0,
    avgHoldTime: 0,
    stopLossTriggered: 0,
    takeProfitTriggered: 0,
    manuallyClosedCount: 0
  };

  constructor(config?: Partial<PositionManagerConfig>) {
    super();
    
    this.config = {
      enabled: true,
      monitoringInterval: 2000, // Check every 2 seconds
      priceCheckThreshold: 0.1, // 0.1% price movement
      emergencyCloseThreshold: 5, // Force close at 5% loss
      trailingStopEnabled: false,
      trailingStopPercent: 1,
      maxPositionAge: 24 * 60 * 60 * 1000, // 24 hours
      riskManagement: {
        maxDrawdownPercent: 10,
        maxDailyLoss: 1000,
        forceCloseOnError: true
      },
      ...config
    };

    this.setupWebSocketListeners();
  }


  start(): void {
    if (!this.config.enabled || this.isRunning) {
      return;
    }

    this.isRunning = true;
    
    // Start monitoring interval
    this.monitoringInterval = setInterval(() => {
      this.monitorPositions();
    }, this.config.monitoringInterval);

    // Load existing positions
    this.loadExistingPositions();
    
    logger.info('PositionManager started', {
      monitoringInterval: this.config.monitoringInterval,
      emergencyThreshold: this.config.emergencyCloseThreshold
    });
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    logger.info('PositionManager stopped');
  }

  async addPosition(position: Omit<ManagedPosition, 'id' | 'status' | 'createdAt' | 'lastUpdate'>): Promise<string> {
    const managedPosition: ManagedPosition = {
      ...position,
      id: uuidv4(),
      status: 'ACTIVE',
      createdAt: Date.now(),
      lastUpdate: Date.now()
    };

    this.positions.set(managedPosition.symbol, managedPosition);
    this.metrics.totalPositions++;
    this.metrics.activePositions++;

    logger.info(`Position added to manager: ${managedPosition.symbol}`, {
      id: managedPosition.id,
      side: managedPosition.side,
      entryPrice: managedPosition.entryPrice,
      stopLoss: managedPosition.stopLossPrice,
      takeProfit: managedPosition.takeProfitPrice
    });

    this.emit('positionAdded', managedPosition);
    return managedPosition.id;
  }

  async removePosition(symbol: string, reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL' | 'EMERGENCY' | 'EXPIRED'): Promise<void> {
    const position = this.positions.get(symbol);
    if (!position) {
      return;
    }

    try {
      // Close position if still active
      if (position.status === 'ACTIVE') {
        await this.closePosition(position, reason, 100);
      }

      // Update metrics
      this.updateCloseMetrics(position, reason);
      
      // Remove from tracking
      this.positions.delete(symbol);
      this.metrics.activePositions--;
      this.metrics.closedPositions++;

      logger.info(`Position removed from manager: ${symbol}`, {
        reason,
        pnl: position.unrealizedPnl,
        holdTime: Date.now() - position.createdAt
      });

      this.emit('positionRemoved', { position, reason });
    } catch (error) {
      logger.error(`Error removing position ${symbol}:`, error);
    }
  }

  private async loadExistingPositions(): Promise<void> {
    try {
      const apiPositions = await apiRequestManager.getPositions() as any;
      
      if (apiPositions.code === 0 && apiPositions.data) {
        for (const pos of apiPositions.data) {
          const positionAmt = parseFloat(pos.positionAmt);
          if (positionAmt !== 0) {
            // Create managed position for existing API position
            const managedPosition: ManagedPosition = {
              id: uuidv4(),
              symbol: pos.symbol,
              side: positionAmt > 0 ? 'LONG' : 'SHORT',
              entryPrice: parseFloat(pos.entryPrice),
              quantity: Math.abs(positionAmt),
              stopLossPrice: 0, // Will be set based on risk management
              takeProfitPrice: 0, // Will be set based on risk management
              orderId: '',
              unrealizedPnl: parseFloat(pos.unrealizedProfit),
              status: 'ACTIVE',
              createdAt: Date.now(),
              lastUpdate: Date.now()
            };

            // Calculate stop loss and take profit based on entry price
            this.calculateRiskLevels(managedPosition);
            
            this.positions.set(managedPosition.symbol, managedPosition);
            this.metrics.activePositions++;
            
            logger.info(`Loaded existing position: ${managedPosition.symbol}`, {
              side: managedPosition.side,
              quantity: managedPosition.quantity,
              unrealizedPnl: managedPosition.unrealizedPnl
            });
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load existing positions:', error);
    }
  }

  private calculateRiskLevels(position: ManagedPosition): void {
    const stopLossPercent = 2; // 2% stop loss
    const takeProfitPercent = 3; // 3% take profit

    if (position.side === 'LONG') {
      position.stopLossPrice = position.entryPrice * (1 - stopLossPercent / 100);
      position.takeProfitPrice = position.entryPrice * (1 + takeProfitPercent / 100);
    } else {
      position.stopLossPrice = position.entryPrice * (1 + stopLossPercent / 100);
      position.takeProfitPrice = position.entryPrice * (1 - takeProfitPercent / 100);
    }
  }

  private async monitorPositions(): Promise<void> {
    if (!this.isRunning || this.positions.size === 0) {
      return;
    }

    const currentTime = Date.now();
    const positionsToCheck = Array.from(this.positions.values())
      .filter(pos => pos.status === 'ACTIVE');

    for (const position of positionsToCheck) {
      try {
        // Check position age
        if (currentTime - position.createdAt > this.config.maxPositionAge) {
          await this.removePosition(position.symbol, 'EXPIRED');
          continue;
        }

        // Get current price
        const currentPrice = await this.getCurrentPrice(position.symbol);
        if (!currentPrice) continue;

        // Check stop loss
        if (this.shouldTriggerStopLoss(position, currentPrice)) {
          await this.removePosition(position.symbol, 'STOP_LOSS');
          continue;
        }

        // Check take profit
        if (this.shouldTriggerTakeProfit(position, currentPrice)) {
          await this.removePosition(position.symbol, 'TAKE_PROFIT');
          continue;
        }

        // Check emergency close threshold
        const currentPnlPercent = this.calculatePnlPercent(position, currentPrice);
        if (Math.abs(currentPnlPercent) > this.config.emergencyCloseThreshold) {
          await this.removePosition(position.symbol, 'EMERGENCY');
          continue;
        }

        // Update position data
        position.unrealizedPnl = this.calculatePnl(position, currentPrice);
        position.lastUpdate = currentTime;

      } catch (error) {
        logger.error(`Error monitoring position ${position.symbol}:`, error);
        
        if (this.config.riskManagement.forceCloseOnError) {
          await this.removePosition(position.symbol, 'EMERGENCY');
        }
      }
    }
  }

  private async getCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const ticker = await apiRequestManager.getTicker(symbol) as any;
      if (ticker.code === 0 && ticker.data) {
        return parseFloat(ticker.data.lastPrice);
      }
      return null;
    } catch (error) {
      logger.error(`Failed to get current price for ${symbol}:`, error);
      return null;
    }
  }

  private shouldTriggerStopLoss(position: ManagedPosition, currentPrice: number): boolean {
    if (position.side === 'LONG') {
      return currentPrice <= position.stopLossPrice;
    } else {
      return currentPrice >= position.stopLossPrice;
    }
  }

  private shouldTriggerTakeProfit(position: ManagedPosition, currentPrice: number): boolean {
    if (position.side === 'LONG') {
      return currentPrice >= position.takeProfitPrice;
    } else {
      return currentPrice <= position.takeProfitPrice;
    }
  }

  private calculatePnl(position: ManagedPosition, currentPrice: number): number {
    if (position.side === 'LONG') {
      return (currentPrice - position.entryPrice) * position.quantity;
    } else {
      return (position.entryPrice - currentPrice) * position.quantity;
    }
  }

  private calculatePnlPercent(position: ManagedPosition, currentPrice: number): number {
    if (position.side === 'LONG') {
      return ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    } else {
      return ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
    }
  }

  private async closePosition(position: ManagedPosition, reason: string, percentage: number = 100): Promise<void> {
    try {
      position.status = 'CLOSING';
      
      logger.info(`Attempting to close ${percentage}% of position ${position.symbol} (${reason})`, {
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        currentPnl: position.unrealizedPnl,
        percentage
      });
      
      // Pre-validate: Check if position actually exists in BingX before attempting close
      try {
        const apiPositions = await apiRequestManager.getPositions() as any;
        
        if (apiPositions.code === 0 && apiPositions.data) {
          const existsInAPI = apiPositions.data.find((pos: any) => 
            pos.symbol === position.symbol && parseFloat(pos.positionAmt) !== 0
          );
          
          if (!existsInAPI) {
            logger.warn(`Position ${position.symbol} not found in BingX API - removing from local tracking`, {
              localPosition: {
                symbol: position.symbol,
                side: position.side,
                status: position.status
              },
              apiPositionsCount: apiPositions.data.length
            });
            
            // Position doesn't exist in API, just remove from local tracking
            position.status = 'CLOSED';
            this.emit('positionAlreadyClosed', {
              position,
              reason: 'Position not found in exchange API'
            });
            return;
          }
        }
      } catch (validationError) {
        logger.warn(`Failed to pre-validate position ${position.symbol}, proceeding with close attempt:`, validationError);
      }
      
      // Actually close the position using BingX API
      const closeResult = await bingxClient.closePosition(position.symbol, percentage);
      
      if (closeResult.code === 0) {
        logger.info(`Position close order executed successfully: ${position.symbol}`, {
          orderId: closeResult.data?.orderId,
          percentage,
          reason
        });
        
        // Mark as closed in our tracking
        position.status = 'CLOSED';
        
        // Update trade record to reflect the close
        if (position.tradeId) {
          await Trade.update(
            {
              realizedPnl: position.unrealizedPnl,
              closedAt: new Date(),
              status: 'FILLED'
            },
            { where: { orderId: position.orderId } }
          );
        }

        // Emit successful close event
        this.emit('positionClosed', {
          position,
          reason,
          percentage,
          orderId: closeResult.data?.orderId
        });
        
      } else {
        throw new Error(`Failed to close position: ${closeResult.msg}`);
      }
      
    } catch (error) {
      logger.error(`Failed to close position ${position.symbol}:`, error);
      position.status = 'ACTIVE'; // Revert status for retry
      
      // Emit error event for UI feedback
      this.emit('positionCloseError', {
        position,
        reason,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw error;
    }
  }

  private updateCloseMetrics(position: ManagedPosition, reason: string): void {
    const holdTime = Date.now() - position.createdAt;
    
    // Update average hold time
    if (this.metrics.avgHoldTime === 0) {
      this.metrics.avgHoldTime = holdTime;
    } else {
      this.metrics.avgHoldTime = (this.metrics.avgHoldTime + holdTime) / 2;
    }

    // Update PnL
    this.metrics.totalPnL += position.unrealizedPnl;

    // Update close reason counters
    switch (reason) {
      case 'STOP_LOSS':
        this.metrics.stopLossTriggered++;
        break;
      case 'TAKE_PROFIT':
        this.metrics.takeProfitTriggered++;
        break;
      case 'MANUAL':
      case 'EMERGENCY':
      case 'EXPIRED':
        this.metrics.manuallyClosedCount++;
        break;
    }

    // Update win rate
    const totalClosed = this.metrics.stopLossTriggered + this.metrics.takeProfitTriggered + this.metrics.manuallyClosedCount;
    if (totalClosed > 0) {
      this.metrics.winRate = (this.metrics.takeProfitTriggered / totalClosed) * 100;
    }
  }

  private setupWebSocketListeners(): void {
    wsManager.on('accountUpdate', (data) => {
      this.handleAccountUpdate(data);
    });

    wsManager.on('orderUpdate', (data) => {
      this.handleOrderUpdate(data);
    });
  }

  private handleAccountUpdate(data: any): void {
    if (data.a && data.a.P) {
      data.a.P.forEach((apiPosition: any) => {
        const symbol = apiPosition.s;
        const amount = parseFloat(apiPosition.pa);
        const managedPosition = this.positions.get(symbol);

        if (managedPosition) {
          if (amount === 0) {
            // Position was closed externally
            this.removePosition(symbol, 'MANUAL');
          } else {
            // Update position data
            managedPosition.unrealizedPnl = parseFloat(apiPosition.up);
            managedPosition.quantity = Math.abs(amount);
            managedPosition.lastUpdate = Date.now();
          }
        }
      });
    }
  }

  private handleOrderUpdate(data: any): void {
    if (data.o && data.o.X === 'FILLED') {
      const order = data.o;
      const symbol = order.s;
      const managedPosition = this.positions.get(symbol);

      if (managedPosition && managedPosition.orderId === order.i) {
        // Update position with filled order data
        managedPosition.lastUpdate = Date.now();
        
        logger.info(`Order update received for managed position: ${symbol}`, {
          orderId: order.i,
          status: order.X
        });
      }
    }
  }

  // Public API methods
  getPositions(): ManagedPosition[] {
    return Array.from(this.positions.values());
  }

  getPosition(symbol: string): ManagedPosition | undefined {
    return this.positions.get(symbol);
  }

  getMetrics(): PositionMetrics {
    return { ...this.metrics };
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      totalPositions: this.positions.size,
      activePositions: Array.from(this.positions.values()).filter(p => p.status === 'ACTIVE').length,
      config: this.config,
      metrics: this.getMetrics()
    };
  }

  updateConfig(newConfig: Partial<PositionManagerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('PositionManager configuration updated');
  }

  // Manual controls - these mark positions for closure but don't execute API calls
  async signalClosePosition(symbol: string): Promise<void> {
    const position = this.positions.get(symbol);
    if (position) {
      logger.info(`Manual close signal for position: ${symbol}`);
      await this.removePosition(symbol, 'MANUAL');
    } else {
      logger.warn(`Position not found for manual close: ${symbol}`);
    }
  }

  async signalCloseAllPositions(): Promise<void> {
    const symbols = Array.from(this.positions.keys());
    logger.info(`Emergency close signal for all ${symbols.length} positions`);
    
    for (const symbol of symbols) {
      await this.removePosition(symbol, 'EMERGENCY');
    }
  }

  // Partial close position signal
  async signalPartialClosePosition(symbol: string, percentage: number, reason: string): Promise<void> {
    const position = this.positions.get(symbol);
    if (position) {
      logger.info(`Partial close signal for position: ${symbol} (${percentage}% - ${reason})`);
      
      try {
        // Actually execute the partial close
        await this.closePosition(position, reason, percentage);
        
        // If it's a full close (100%), remove from tracking
        if (percentage === 100) {
          await this.removePosition(symbol, 'MANUAL');
        } else {
          // For partial closes, emit event but keep position active for remainder
          this.emit('partialCloseExecuted', { 
            symbol, 
            percentage, 
            reason, 
            position: { ...position } 
          });
        }
      } catch (error) {
        logger.error(`Failed to execute partial close for ${symbol}:`, error);
        throw error;
      }
    } else {
      logger.warn(`Position not found for partial close: ${symbol}`);
      throw new Error(`Position not found: ${symbol}`);
    }
  }

  // Update position stop-loss and take-profit levels
  async updatePositionLevels(symbol: string, levels: { stopLoss?: number; takeProfit?: number }): Promise<void> {
    const position = this.positions.get(symbol);
    if (position) {
      if (levels.stopLoss !== undefined) {
        position.stopLossPrice = levels.stopLoss;
      }
      if (levels.takeProfit !== undefined) {
        position.takeProfitPrice = levels.takeProfit;
      }
      
      position.lastUpdate = Date.now();
      
      logger.info(`Position levels updated for ${symbol}:`, {
        stopLoss: position.stopLossPrice,
        takeProfit: position.takeProfitPrice
      });
      
      this.emit('positionLevelsUpdated', { 
        symbol, 
        levels: {
          stopLoss: position.stopLossPrice,
          takeProfit: position.takeProfitPrice
        },
        position: { ...position }
      });
    } else {
      logger.warn(`Position not found for level update: ${symbol}`);
    }
  }

  // Real close position - to be called when position is actually closed externally
  async confirmPositionClosed(symbol: string, actualPnl?: number): Promise<void> {
    const position = this.positions.get(symbol);
    if (position) {
      if (actualPnl !== undefined) {
        position.unrealizedPnl = actualPnl;
      }
      
      this.positions.delete(symbol);
      this.metrics.activePositions--;
      this.metrics.closedPositions++;
      
      logger.info(`Position closure confirmed: ${symbol}`, {
        finalPnl: position.unrealizedPnl
      });
      
      this.emit('positionConfirmedClosed', { position, actualPnl });
    }
  }
}