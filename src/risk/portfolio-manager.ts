import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { Position, Balance } from '../types/tradestation';
import { createLogger } from '../utils/logger';

export interface PortfolioMetrics {
  totalValue: number;
  totalEquity: number;
  totalCash: number;
  totalPnL: number;
  dayPnL: number;
  positions: Position[];
  positionCount: number;
  largestPosition: number;
  smallestPosition: number;
  averagePositionSize: number;
  sectorAllocation: Map<string, number>;
  riskMetrics: {
    concentration: number;
    diversification: number;
    maxDrawdown: number;
    sharpeRatio: number;
  };
}

export class PortfolioManager extends EventEmitter {
  private logger: Logger;
  private positions: Position[] = [];
  private balances: Balance[] = [];
  private historicalPnL: number[] = [];
  private lastUpdateTime: Date = new Date();

  constructor() {
    super();
    this.logger = createLogger('PortfolioManager');
  }

  updatePositions(positions: Position[]): void {
    this.positions = [...positions];
    this.lastUpdateTime = new Date();
    this.logger.debug(`Updated positions: ${positions.length} positions`);
    this.emit('positionsUpdated', positions);
    this.calculateMetrics();
  }

  updateBalances(balances: Balance[]): void {
    this.balances = [...balances];
    this.lastUpdateTime = new Date();
    this.logger.debug(`Updated balances: ${balances.length} accounts`);
    this.emit('balancesUpdated', balances);
    this.calculateMetrics();
  }

  getTotalValue(): number {
    try {
      let totalValue = 0;
      
      // Add cash balances
      for (const balance of this.balances) {
        totalValue += parseFloat(balance.CashBalance);
        totalValue += parseFloat(balance.MarketValue);
      }
      
      return totalValue;
    } catch (error) {
      this.logger.error('Error calculating total portfolio value:', error);
      return 0;
    }
  }

  getAvailableCash(): number {
    try {
      let totalCash = 0;
      
      for (const balance of this.balances) {
        totalCash += parseFloat(balance.CashBalance);
      }
      
      return totalCash;
    } catch (error) {
      this.logger.error('Error calculating available cash:', error);
      return 0;
    }
  }

  getTotalEquityValue(): number {
    try {
      let totalEquity = 0;
      
      for (const position of this.positions) {
        const marketValue = parseFloat(position.Quantity) * parseFloat(position.LastPrice);
        totalEquity += marketValue;
      }
      
      return totalEquity;
    } catch (error) {
      this.logger.error('Error calculating total equity value:', error);
      return 0;
    }
  }

  getTotalPnL(): number {
    try {
      let totalPnL = 0;
      
      for (const position of this.positions) {
        const unrealizedPnL = parseFloat(position.UnrealizedProfitLoss);
        totalPnL += unrealizedPnL;
      }
      
      return totalPnL;
    } catch (error) {
      this.logger.error('Error calculating total P&L:', error);
      return 0;
    }
  }

  getDayPnL(): number {
    try {
      let dayPnL = 0;
      
      for (const position of this.positions) {
        // Simplified day P&L calculation
        const quantity = parseFloat(position.Quantity);
        const lastPrice = parseFloat(position.LastPrice);
        const previousClose = parseFloat(position.AveragePrice); // Simplified
        
        dayPnL += quantity * (lastPrice - previousClose);
      }
      
      return dayPnL;
    } catch (error) {
      this.logger.error('Error calculating day P&L:', error);
      return 0;
    }
  }

  getPositionBySymbol(symbol: string): Position | null {
    return this.positions.find(p => p.Symbol === symbol) || null;
  }

  getPositionsByAccount(accountId: string): Position[] {
    return this.positions.filter(p => p.AccountID === accountId);
  }

  calculateMetrics(): PortfolioMetrics {
    try {
      const totalValue = this.getTotalValue();
      const totalEquity = this.getTotalEquityValue();
      const totalCash = this.getAvailableCash();
      const totalPnL = this.getTotalPnL();
      const dayPnL = this.getDayPnL();

      // Position statistics
      const positionValues = this.positions.map(p => 
        Math.abs(parseFloat(p.Quantity) * parseFloat(p.LastPrice))
      );

      const largestPosition = positionValues.length > 0 ? Math.max(...positionValues) : 0;
      const smallestPosition = positionValues.length > 0 ? Math.min(...positionValues) : 0;
      const averagePositionSize = positionValues.length > 0 
        ? positionValues.reduce((sum, val) => sum + val, 0) / positionValues.length 
        : 0;

      // Sector allocation (simplified - would need real sector data)
      const sectorAllocation = this.calculateSectorAllocation();

      // Risk metrics
      const riskMetrics = this.calculateRiskMetrics(totalValue, positionValues);

      const metrics: PortfolioMetrics = {
        totalValue,
        totalEquity,
        totalCash,
        totalPnL,
        dayPnL,
        positions: [...this.positions],
        positionCount: this.positions.length,
        largestPosition,
        smallestPosition,
        averagePositionSize,
        sectorAllocation,
        riskMetrics
      };

      this.emit('metricsCalculated', metrics);
      return metrics;
    } catch (error) {
      this.logger.error('Error calculating portfolio metrics:', error);
      throw error;
    }
  }

  private calculateSectorAllocation(): Map<string, number> {
    const allocation = new Map<string, number>();
    
    // Simplified sector classification based on symbol
    for (const position of this.positions) {
      const value = Math.abs(parseFloat(position.Quantity) * parseFloat(position.LastPrice));
      
      // Very simplified sector assignment - in reality you'd use a proper sector mapping
      let sector = 'Technology'; // Default
      if (position.Symbol.includes('XLF')) sector = 'Financial';
      else if (position.Symbol.includes('XLE')) sector = 'Energy';
      else if (position.Symbol.includes('XLK')) sector = 'Technology';
      else if (position.Symbol.includes('SPY') || position.Symbol.includes('QQQ')) sector = 'ETF';
      
      allocation.set(sector, (allocation.get(sector) || 0) + value);
    }
    
    return allocation;
  }

  private calculateRiskMetrics(totalValue: number, positionValues: number[]): any {
    const concentration = totalValue > 0 && positionValues.length > 0 
      ? Math.max(...positionValues) / totalValue 
      : 0;

    // Simplified diversification score (inverse of concentration)
    const diversification = positionValues.length > 0 
      ? Math.min(1, positionValues.length / 20) // Max diversification at 20+ positions
      : 0;

    // Track historical P&L for drawdown calculation
    const currentPnL = this.getTotalPnL();
    this.historicalPnL.push(currentPnL);
    
    // Keep only last 100 data points
    if (this.historicalPnL.length > 100) {
      this.historicalPnL = this.historicalPnL.slice(-100);
    }

    const maxDrawdown = this.calculateMaxDrawdown();
    const sharpeRatio = this.calculateSharpeRatio();

    return {
      concentration,
      diversification,
      maxDrawdown,
      sharpeRatio
    };
  }

  private calculateMaxDrawdown(): number {
    if (this.historicalPnL.length < 2) return 0;

    let maxDrawdown = 0;
    let peak = this.historicalPnL[0];

    for (let i = 1; i < this.historicalPnL.length; i++) {
      if (this.historicalPnL[i] > peak) {
        peak = this.historicalPnL[i];
      } else {
        const drawdown = (peak - this.historicalPnL[i]) / Math.abs(peak);
        maxDrawdown = Math.max(maxDrawdown, drawdown);
      }
    }

    return maxDrawdown;
  }

  private calculateSharpeRatio(): number {
    if (this.historicalPnL.length < 2) return 0;

    // Calculate returns
    const returns = [];
    for (let i = 1; i < this.historicalPnL.length; i++) {
      const previousValue = this.historicalPnL[i - 1];
      if (previousValue !== 0) {
        returns.push((this.historicalPnL[i] - previousValue) / Math.abs(previousValue));
      }
    }

    if (returns.length === 0) return 0;

    // Calculate mean return and standard deviation
    const meanReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - meanReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    // Sharpe ratio (assuming risk-free rate of 0)
    return stdDev > 0 ? meanReturn / stdDev : 0;
  }

  // Portfolio optimization suggestions
  getRebalancingSuggestions(): any[] {
    const suggestions = [];
    const metrics = this.calculateMetrics();
    
    try {
      // Check for over-concentration
      if (metrics.riskMetrics.concentration > 0.2) { // 20% threshold
        suggestions.push({
          type: 'REDUCE_CONCENTRATION',
          message: `Largest position represents ${(metrics.riskMetrics.concentration * 100).toFixed(1)}% of portfolio`,
          severity: 'HIGH',
          action: 'Consider reducing position size'
        });
      }

      // Check for under-diversification
      if (metrics.positionCount < 5) {
        suggestions.push({
          type: 'INCREASE_DIVERSIFICATION',
          message: `Portfolio has only ${metrics.positionCount} positions`,
          severity: 'MEDIUM',
          action: 'Consider adding more positions to improve diversification'
        });
      }

      // Check cash allocation
      const cashRatio = metrics.totalCash / metrics.totalValue;
      if (cashRatio > 0.2) {
        suggestions.push({
          type: 'HIGH_CASH_ALLOCATION',
          message: `${(cashRatio * 100).toFixed(1)}% of portfolio is in cash`,
          severity: 'LOW',
          action: 'Consider deploying excess cash'
        });
      }

      return suggestions;
    } catch (error) {
      this.logger.error('Error generating rebalancing suggestions:', error);
      return [];
    }
  }

  // Export/reporting methods
  generatePortfolioReport(): any {
    const metrics = this.calculateMetrics();
    const suggestions = this.getRebalancingSuggestions();
    
    return {
      timestamp: new Date(),
      summary: {
        totalValue: metrics.totalValue,
        totalPnL: metrics.totalPnL,
        dayPnL: metrics.dayPnL,
        positionCount: metrics.positionCount
      },
      breakdown: {
        cash: metrics.totalCash,
        equity: metrics.totalEquity,
        largestPosition: metrics.largestPosition,
        averagePositionSize: metrics.averagePositionSize
      },
      riskMetrics: metrics.riskMetrics,
      sectorAllocation: Object.fromEntries(metrics.sectorAllocation),
      suggestions,
      positions: metrics.positions.map(p => ({
        symbol: p.Symbol,
        quantity: p.Quantity,
        averagePrice: p.AveragePrice,
        lastPrice: p.LastPrice,
        marketValue: (parseFloat(p.Quantity) * parseFloat(p.LastPrice)).toFixed(2),
        unrealizedPnL: p.UnrealizedProfitLoss
      }))
    };
  }
}