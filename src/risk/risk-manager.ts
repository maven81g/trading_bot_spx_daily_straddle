import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { Signal, MarketContext } from '../types/strategy';
import { Position } from '../types/tradestation';
import { createLogger } from '../utils/logger';

export interface RiskManagementConfig {
  maxDailyLoss: number;
  maxDrawdown: number;
  maxPositionsPerSymbol: number;
  maxTotalPositions: number;
}

export interface RiskViolation {
  type: 'DAILY_LOSS' | 'DRAWDOWN' | 'POSITION_LIMIT' | 'EXPOSURE';
  message: string;
  signal?: Signal;
  currentValue: number;
  limit: number;
  timestamp: Date;
}

export class RiskManager extends EventEmitter {
  private logger: Logger;
  private config: RiskManagementConfig;
  private dailyPnL: number = 0;
  private totalDrawdown: number = 0;
  private dailyStartTime: Date;

  constructor(config: RiskManagementConfig) {
    super();
    this.config = config;
    this.logger = createLogger('RiskManager');
    this.dailyStartTime = new Date();
    this.resetDailyMetrics();
  }

  validateSignal(signal: Signal, context: MarketContext): boolean {
    try {
      // Check daily loss limit
      if (!this.checkDailyLossLimit()) {
        this.emitViolation({
          type: 'DAILY_LOSS',
          message: `Daily loss limit exceeded: ${this.dailyPnL.toFixed(2)}`,
          signal,
          currentValue: Math.abs(this.dailyPnL),
          limit: this.config.maxDailyLoss,
          timestamp: new Date()
        });
        return false;
      }

      // Check drawdown limit
      if (!this.checkDrawdownLimit()) {
        this.emitViolation({
          type: 'DRAWDOWN',
          message: `Drawdown limit exceeded: ${this.totalDrawdown.toFixed(2)}`,
          signal,
          currentValue: this.totalDrawdown,
          limit: this.config.maxDrawdown,
          timestamp: new Date()
        });
        return false;
      }

      // Check position limits
      if (!this.checkPositionLimits(signal.symbol, context.positions)) {
        this.emitViolation({
          type: 'POSITION_LIMIT',
          message: `Position limit exceeded for ${signal.symbol}`,
          signal,
          currentValue: context.positions.length,
          limit: this.config.maxPositionsPerSymbol,
          timestamp: new Date()
        });
        return false;
      }

      // Check total position limit
      const totalPositions = this.getTotalPositionCount(context);
      if (totalPositions >= this.config.maxTotalPositions) {
        this.emitViolation({
          type: 'POSITION_LIMIT',
          message: `Total position limit exceeded: ${totalPositions}`,
          signal,
          currentValue: totalPositions,
          limit: this.config.maxTotalPositions,
          timestamp: new Date()
        });
        return false;
      }

      // Check exposure limits (simplified)
      if (!this.checkExposureLimit(signal, context)) {
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('Error validating signal:', error);
      return false;
    }
  }

  private checkDailyLossLimit(): boolean {
    return Math.abs(this.dailyPnL) <= this.config.maxDailyLoss;
  }

  private checkDrawdownLimit(): boolean {
    return this.totalDrawdown <= this.config.maxDrawdown;
  }

  private checkPositionLimits(symbol: string, positions: Position[]): boolean {
    const symbolPositions = positions.filter(p => p.Symbol === symbol);
    return symbolPositions.length < this.config.maxPositionsPerSymbol;
  }

  private getTotalPositionCount(context: MarketContext): number {
    return context.positions.length;
  }

  private checkExposureLimit(signal: Signal, context: MarketContext): boolean {
    // Calculate current exposure for the symbol
    const symbolPositions = context.positions.filter(p => p.Symbol === signal.symbol);
    const currentExposure = symbolPositions.reduce((total, pos) => {
      return total + (parseFloat(pos.Quantity) * parseFloat(pos.AveragePrice));
    }, 0);

    // Calculate new exposure if signal is executed
    const signalExposure = signal.quantity * signal.price;
    const newExposure = Math.abs(currentExposure + signalExposure);

    // Check if new exposure exceeds percentage of portfolio
    const maxExposurePerSymbol = context.portfolioValue * 0.1; // 10% max per symbol

    if (newExposure > maxExposurePerSymbol) {
      this.emitViolation({
        type: 'EXPOSURE',
        message: `Exposure limit exceeded for ${signal.symbol}: ${newExposure.toFixed(2)}`,
        signal,
        currentValue: newExposure,
        limit: maxExposurePerSymbol,
        timestamp: new Date()
      });
      return false;
    }

    return true;
  }

  updateDailyPnL(pnl: number): void {
    this.dailyPnL += pnl;
    
    // Update drawdown if we have a loss
    if (pnl < 0) {
      this.totalDrawdown = Math.max(this.totalDrawdown, Math.abs(this.dailyPnL));
    }

    this.logger.debug(`Updated daily P&L: ${this.dailyPnL.toFixed(2)}, Drawdown: ${this.totalDrawdown.toFixed(2)}`);
  }

  resetDailyMetrics(): void {
    const now = new Date();
    const isNewDay = now.getDate() !== this.dailyStartTime.getDate() || 
                     now.getMonth() !== this.dailyStartTime.getMonth() ||
                     now.getFullYear() !== this.dailyStartTime.getFullYear();

    if (isNewDay) {
      this.logger.info('Resetting daily metrics for new trading day');
      this.dailyPnL = 0;
      this.dailyStartTime = now;
    }
  }

  calculatePositionSize(
    signal: Signal, 
    context: MarketContext, 
    riskPerTrade: number = 0.02
  ): number {
    try {
      // Calculate position size based on risk per trade
      const accountValue = context.portfolioValue;
      const riskAmount = accountValue * riskPerTrade;
      
      // Estimate stop loss distance (simplified)
      const stopLossDistance = signal.price * 0.02; // 2% stop loss
      
      // Calculate position size
      const positionSize = Math.floor(riskAmount / stopLossDistance);
      
      // Cap position size to original signal quantity
      return Math.min(positionSize, signal.quantity);
    } catch (error) {
      this.logger.error('Error calculating position size:', error);
      return signal.quantity;
    }
  }

  private emitViolation(violation: RiskViolation): void {
    this.logger.warn('Risk violation detected:', violation);
    this.emit('riskViolation', violation);
  }

  // Portfolio risk metrics
  calculatePortfolioRisk(positions: Position[], portfolioValue: number): any {
    try {
      const metrics = {
        totalExposure: 0,
        sectorExposure: new Map<string, number>(),
        topPositions: [] as any[],
        concentrationRisk: 0,
        betaWeighted: 0 // Would need beta data
      };

      // Calculate total exposure
      for (const position of positions) {
        const exposure = parseFloat(position.Quantity) * parseFloat(position.AveragePrice);
        metrics.totalExposure += Math.abs(exposure);
      }

      // Calculate concentration risk (largest position as % of portfolio)
      if (positions.length > 0) {
        const exposures = positions.map(p => 
          Math.abs(parseFloat(p.Quantity) * parseFloat(p.AveragePrice))
        );
        metrics.concentrationRisk = Math.max(...exposures) / portfolioValue;
      }

      return metrics;
    } catch (error) {
      this.logger.error('Error calculating portfolio risk:', error);
      return null;
    }
  }

  // Emergency stop methods
  shouldEmergencyStop(): boolean {
    return (
      !this.checkDailyLossLimit() ||
      !this.checkDrawdownLimit()
    );
  }

  getCurrentRiskMetrics(): any {
    return {
      dailyPnL: this.dailyPnL,
      totalDrawdown: this.totalDrawdown,
      dailyLossLimit: this.config.maxDailyLoss,
      drawdownLimit: this.config.maxDrawdown,
      maxPositionsPerSymbol: this.config.maxPositionsPerSymbol,
      maxTotalPositions: this.config.maxTotalPositions,
      lastReset: this.dailyStartTime
    };
  }

  updateConfig(newConfig: Partial<RiskManagementConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Risk management configuration updated:', newConfig);
  }
}