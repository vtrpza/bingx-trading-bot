import { EventEmitter } from 'events';
import { apiRequestManager } from '../services/APIRequestManager';
import { logger } from '../utils/logger';

export interface RiskParameters {
  maxDrawdownPercent: number;
  maxDailyLossUSDT: number;
  maxPositionSizePercent: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  riskRewardRatio: number;
  maxLeverage: number;
}

export interface PositionRisk {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  size: number;
  side: 'LONG' | 'SHORT';
  unrealizedPnl: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  breakEvenPrice: number;
  liquidationPrice: number;
  marginRatio: number;
  riskAmount: number;
  rewardAmount: number;
  riskRewardRatio: number;
  trailingStopPrice?: number;
  isBreakEvenSet: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface TradeValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  riskAssessment: {
    riskAmount: number;
    rewardPotential: number;
    riskRewardRatio: number;
    maxLoss: number;
    marginRequired: number;
  };
}

export class RiskManager extends EventEmitter {
  private riskParams: RiskParameters;
  private isActive: boolean = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private dailyStartBalance: number = 0;
  private dailyPnl: number = 0;

  constructor(riskParams: RiskParameters) {
    super();
    this.riskParams = riskParams;
  }

  /**
   * Start risk monitoring - STRICT mode, no fallbacks
   */
  async start(): Promise<void> {
    try {
      // Get initial account balance - MANDATORY
      const balanceResponse = await apiRequestManager.getBalance() as any;
      if (balanceResponse.code !== 0 || !balanceResponse.data) {
        throw new Error(`CRITICAL: Cannot start risk management - Balance API failed: ${balanceResponse.msg || 'Unknown error'}`);
      }

      this.dailyStartBalance = this.extractUSDTBalance(balanceResponse.data);
      if (this.dailyStartBalance <= 0) {
        throw new Error(`CRITICAL: Invalid account balance: ${this.dailyStartBalance}`);
      }

      this.isActive = true;
      
      // Start monitoring every 5 seconds - NO FALLBACKS
      this.monitoringInterval = setInterval(async () => {
        try {
          await this.monitorRisk();
        } catch (error) {
          logger.error('CRITICAL: Risk monitoring failed:', error);
          this.emit('riskMonitoringError', error);
          // Do not stop - let the error propagate
        }
      }, 5000);

      logger.info('Risk Manager started - STRICT MODE', {
        startBalance: this.dailyStartBalance,
        maxDailyLoss: this.riskParams.maxDailyLossUSDT,
        maxDrawdown: this.riskParams.maxDrawdownPercent
      });

    } catch (error) {
      this.isActive = false;
      throw new Error(`FAILED TO START RISK MANAGER: ${error}`);
    }
  }

  /**
   * Stop risk monitoring
   */
  stop(): void {
    this.isActive = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    logger.info('Risk Manager stopped');
  }

  /**
   * Validate trade before execution - STRICT validation
   */
  async validateTrade(
    symbol: string,
    side: 'BUY' | 'SELL',
    size: number,
    entryPrice: number
  ): Promise<TradeValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // 1. Get current account balance - MANDATORY
      const balanceResponse = await apiRequestManager.getBalance() as any;
      if (balanceResponse.code !== 0 || !balanceResponse.data) {
        errors.push(`CRITICAL: Cannot validate trade - Balance API failed: ${balanceResponse.msg}`);
        return { isValid: false, errors, warnings, riskAssessment: this.getEmptyRiskAssessment() };
      }

      const currentBalance = this.extractUSDTBalance(balanceResponse.data);
      if (currentBalance <= 0) {
        errors.push(`CRITICAL: Invalid account balance: ${currentBalance}`);
        return { isValid: false, errors, warnings, riskAssessment: this.getEmptyRiskAssessment() };
      }

      // 2. Get current positions - MANDATORY
      const positionsResponse = await apiRequestManager.getPositions() as any;
      if (positionsResponse.code !== 0) {
        errors.push(`CRITICAL: Cannot validate trade - Positions API failed: ${positionsResponse.msg}`);
        return { isValid: false, errors, warnings, riskAssessment: this.getEmptyRiskAssessment() };
      }

      // 3. Calculate position size limits
      const notionalValue = size * entryPrice;
      const maxPositionSize = currentBalance * (this.riskParams.maxPositionSizePercent / 100);
      
      if (notionalValue > maxPositionSize) {
        errors.push(`Position size too large: ${notionalValue.toFixed(2)} USDT exceeds maximum ${maxPositionSize.toFixed(2)} USDT`);
      }

      // 4. Check existing positions for symbol
      const existingPosition = this.findExistingPosition(positionsResponse.data, symbol);
      if (existingPosition) {
        warnings.push(`Existing position detected for ${symbol}: ${existingPosition.positionAmt}`);
      }

      // 5. Calculate risk parameters
      const stopLossPrice = this.calculateStopLossPrice(entryPrice, side, this.riskParams.stopLossPercent);
      const takeProfitPrice = this.calculateTakeProfitPrice(entryPrice, side, this.riskParams.takeProfitPercent);
      
      const riskAmount = Math.abs((entryPrice - stopLossPrice) * size);
      const rewardAmount = Math.abs((takeProfitPrice - entryPrice) * size);
      const riskRewardRatio = rewardAmount / riskAmount;

      // 6. Risk/Reward validation
      if (riskRewardRatio < this.riskParams.riskRewardRatio) {
        errors.push(`Risk/Reward ratio too low: ${riskRewardRatio.toFixed(2)} < ${this.riskParams.riskRewardRatio}`);
      }

      // 7. Daily loss check
      if (this.dailyPnl < 0 && Math.abs(this.dailyPnl) + riskAmount > this.riskParams.maxDailyLossUSDT) {
        errors.push(`Trade would exceed daily loss limit: ${(Math.abs(this.dailyPnl) + riskAmount).toFixed(2)} > ${this.riskParams.maxDailyLossUSDT}`);
      }

      // 8. Margin requirement calculation
      const marginRequired = notionalValue / this.riskParams.maxLeverage;
      if (marginRequired > currentBalance * 0.9) { // Max 90% of balance
        errors.push(`Insufficient margin: Required ${marginRequired.toFixed(2)}, Available ~${(currentBalance * 0.9).toFixed(2)}`);
      }

      const riskAssessment = {
        riskAmount,
        rewardPotential: rewardAmount,
        riskRewardRatio,
        maxLoss: riskAmount,
        marginRequired
      };

      return {
        isValid: errors.length === 0,
        errors,
        warnings,
        riskAssessment
      };

    } catch (error) {
      errors.push(`CRITICAL VALIDATION ERROR: ${error}`);
      return {
        isValid: false,
        errors,
        warnings,
        riskAssessment: this.getEmptyRiskAssessment()
      };
    }
  }

  /**
   * Monitor all positions for risk management
   */
  private async monitorRisk(): Promise<void> {
    if (!this.isActive) return;

    try {
      // Get current positions - STRICT requirement
      const positionsResponse = await apiRequestManager.getPositions() as any;
      if (positionsResponse.code !== 0) {
        throw new Error(`Positions API failed: ${positionsResponse.msg}`);
      }

      const positions = positionsResponse.data || [];
      const activePositions = positions.filter((pos: any) => parseFloat(pos.positionAmt) !== 0);

      for (const position of activePositions) {
        const positionRisk = await this.analyzePositionRisk(position);
        
        // Check for emergency actions needed
        if (positionRisk.riskLevel === 'CRITICAL') {
          this.emit('emergencyStop', positionRisk);
        } else if (positionRisk.isBreakEvenSet && this.shouldMoveToBreakEven(positionRisk)) {
          this.emit('moveToBreakEven', positionRisk);
        } else if (this.shouldActivateTrailingStop(positionRisk)) {
          this.emit('activateTrailingStop', positionRisk);
        }
      }

      // Update daily P&L
      await this.updateDailyPnl();

      // Check daily limits
      if (Math.abs(this.dailyPnl) > this.riskParams.maxDailyLossUSDT) {
        this.emit('dailyLimitExceeded', {
          dailyPnl: this.dailyPnl,
          limit: this.riskParams.maxDailyLossUSDT
        });
      }

    } catch (error) {
      // NO FALLBACKS - let error propagate
      throw error;
    }
  }

  /**
   * Analyze individual position risk
   */
  private async analyzePositionRisk(position: any): Promise<PositionRisk> {
    const entryPrice = parseFloat(position.entryPrice);
    const markPrice = parseFloat(position.markPrice);
    const size = Math.abs(parseFloat(position.positionAmt));
    const side = parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const unrealizedPnl = parseFloat(position.unrealizedProfit || '0');

    if (entryPrice <= 0 || markPrice <= 0) {
      throw new Error(`CRITICAL: Invalid price data for ${position.symbol} - Entry: ${entryPrice}, Mark: ${markPrice}`);
    }

    // Calculate risk management levels
    const stopLossPrice = this.calculateStopLossPrice(entryPrice, side === 'LONG' ? 'BUY' : 'SELL', this.riskParams.stopLossPercent);
    const takeProfitPrice = this.calculateTakeProfitPrice(entryPrice, side === 'LONG' ? 'BUY' : 'SELL', this.riskParams.takeProfitPercent);
    const breakEvenPrice = this.calculateBreakEvenPrice(entryPrice, side);

    // Calculate trailing stop if applicable
    let trailingStopPrice: number | undefined;
    if (this.shouldActivateTrailingStop({ unrealizedPnl, entryPrice, side } as any)) {
      trailingStopPrice = this.calculateTrailingStopPrice(entryPrice, markPrice, side, this.riskParams.trailingStopPercent);
    }

    // Risk assessment
    const riskAmount = Math.abs((entryPrice - stopLossPrice) * size);
    const rewardAmount = Math.abs((takeProfitPrice - entryPrice) * size);
    const currentPnlPercent = (unrealizedPnl / (entryPrice * size)) * 100;

    // Determine risk level
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
    if (currentPnlPercent < -this.riskParams.maxDrawdownPercent * 0.8) riskLevel = 'CRITICAL';
    else if (currentPnlPercent < -this.riskParams.stopLossPercent * 0.8) riskLevel = 'HIGH';
    else if (currentPnlPercent < -this.riskParams.stopLossPercent * 0.5) riskLevel = 'MEDIUM';

    return {
      symbol: position.symbol,
      entryPrice,
      currentPrice: markPrice,
      size,
      side,
      unrealizedPnl,
      stopLossPrice,
      takeProfitPrice,
      breakEvenPrice,
      liquidationPrice: parseFloat(position.liquidationPrice || '0'),
      marginRatio: parseFloat(position.marginRatio || '0'),
      riskAmount,
      rewardAmount,
      riskRewardRatio: rewardAmount / riskAmount,
      trailingStopPrice,
      isBreakEvenSet: Math.abs(currentPnlPercent) > 1, // If profit > 1%, consider break-even
      riskLevel
    };
  }

  /**
   * Calculate break-even price including fees
   */
  private calculateBreakEvenPrice(entryPrice: number, side: 'LONG' | 'SHORT'): number {
    const feePercent = 0.075; // 0.075% fee assumption
    const totalFeePercent = feePercent * 2; // Entry + Exit fees
    
    if (side === 'LONG') {
      return entryPrice * (1 + totalFeePercent / 100);
    } else {
      return entryPrice * (1 - totalFeePercent / 100);
    }
  }

  /**
   * Calculate stop loss price
   */
  private calculateStopLossPrice(entryPrice: number, side: 'BUY' | 'SELL', stopLossPercent: number): number {
    const stopLossMultiplier = stopLossPercent / 100;
    
    if (side === 'BUY') {
      return entryPrice * (1 - stopLossMultiplier);
    } else {
      return entryPrice * (1 + stopLossMultiplier);
    }
  }

  /**
   * Calculate take profit price
   */
  private calculateTakeProfitPrice(entryPrice: number, side: 'BUY' | 'SELL', takeProfitPercent: number): number {
    const takeProfitMultiplier = takeProfitPercent / 100;
    
    if (side === 'BUY') {
      return entryPrice * (1 + takeProfitMultiplier);
    } else {
      return entryPrice * (1 - takeProfitMultiplier);
    }
  }

  /**
   * Calculate trailing stop price
   */
  private calculateTrailingStopPrice(_entryPrice: number, currentPrice: number, side: 'LONG' | 'SHORT', trailingPercent: number): number {
    const trailingMultiplier = trailingPercent / 100;
    
    if (side === 'LONG') {
      return currentPrice * (1 - trailingMultiplier);
    } else {
      return currentPrice * (1 + trailingMultiplier);
    }
  }

  /**
   * Check if position should move to break-even
   */
  private shouldMoveToBreakEven(positionRisk: PositionRisk): boolean {
    const profitPercent = (positionRisk.unrealizedPnl / (positionRisk.entryPrice * positionRisk.size)) * 100;
    return profitPercent > 2; // Move to break-even when 2% profit
  }

  /**
   * Check if trailing stop should be activated
   */
  private shouldActivateTrailingStop(positionRisk: PositionRisk): boolean {
    const profitPercent = (positionRisk.unrealizedPnl / (positionRisk.entryPrice * positionRisk.size)) * 100;
    return profitPercent > this.riskParams.takeProfitPercent * 0.5; // Activate at 50% of take profit
  }

  /**
   * Update daily P&L tracking
   */
  private async updateDailyPnl(): Promise<void> {
    try {
      const balanceResponse = await apiRequestManager.getBalance() as any;
      if (balanceResponse.code !== 0 || !balanceResponse.data) {
        throw new Error(`Balance API failed for daily P&L update: ${balanceResponse.msg}`);
      }

      const currentBalance = this.extractUSDTBalance(balanceResponse.data);
      this.dailyPnl = currentBalance - this.dailyStartBalance;

    } catch (error) {
      throw new Error(`Failed to update daily P&L: ${error}`);
    }
  }

  /**
   * Extract USDT balance from API response
   */
  private extractUSDTBalance(balanceData: any): number {
    const baseCurrency = process.env.DEMO_MODE === 'true' ? 'VST' : 'USDT';
    
    if (Array.isArray(balanceData)) {
      const usdtBalance = balanceData.find((b: any) => b.asset === baseCurrency);
      return usdtBalance ? parseFloat(usdtBalance.availableMargin || usdtBalance.balance || '0') : 0;
    } else if (balanceData.balance) {
      if (Array.isArray(balanceData.balance)) {
        const usdtBalance = balanceData.balance.find((b: any) => b.asset === baseCurrency);
        return usdtBalance ? parseFloat(usdtBalance.availableMargin || usdtBalance.balance || '0') : 0;
      } else if (balanceData.balance.asset === baseCurrency) {
        return parseFloat(balanceData.balance.availableMargin || balanceData.balance.balance || '0');
      }
    }
    
    throw new Error(`USDT/VST balance not found in response structure`);
  }

  /**
   * Find existing position for symbol
   */
  private findExistingPosition(positions: any[], symbol: string): any | null {
    return positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0) || null;
  }

  /**
   * Get empty risk assessment for error cases
   */
  private getEmptyRiskAssessment() {
    return {
      riskAmount: 0,
      rewardPotential: 0,
      riskRewardRatio: 0,
      maxLoss: 0,
      marginRequired: 0
    };
  }

  /**
   * Get current risk parameters
   */
  getRiskParameters(): RiskParameters {
    return { ...this.riskParams };
  }

  /**
   * Update risk parameters
   */
  updateRiskParameters(newParams: Partial<RiskParameters>): void {
    this.riskParams = { ...this.riskParams, ...newParams };
    logger.info('Risk parameters updated:', newParams);
  }

  /**
   * Get daily P&L
   */
  getDailyPnl(): number {
    return this.dailyPnl;
  }

  /**
   * Check if risk manager is active
   */
  isRiskManagerActive(): boolean {
    return this.isActive;
  }
}