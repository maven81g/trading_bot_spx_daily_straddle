// Base Strategy Class

import { EventEmitter } from 'events';
import { Logger } from 'winston';
import {
  IStrategy,
  StrategyConfig,
  StrategyPerformance,
  StrategyState,
  Signal,
  SignalType,
  TradeRecord,
  MarketContext,
  ConditionGroup,
  ICondition
} from '../types/strategy';
import { Bar, Quote, OrderRequest } from '../types/tradestation';
import { createLogger } from '../utils/logger';
import { ConditionEvaluator } from './condition-evaluator';

export abstract class BaseStrategy extends EventEmitter implements IStrategy {
  public readonly id: string;
  public readonly name: string;
  public config: StrategyConfig;
  
  protected logger: Logger;
  protected state: StrategyState = 'INACTIVE';
  protected performance: StrategyPerformance;
  protected trades: TradeRecord[] = [];
  protected conditionEvaluator: ConditionEvaluator;
  protected lastSignalTime: Map<string, Date> = new Map();
  protected marketData: Map<string, Bar[]> = new Map();
  protected currentPositions: Map<string, number> = new Map();

  constructor(config: StrategyConfig) {
    super();
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.logger = createLogger(`Strategy:${this.name}`);
    this.conditionEvaluator = new ConditionEvaluator();
    
    this.performance = {
      strategyId: this.id,
      symbol: config.symbols[0] || 'MULTI',
      startDate: new Date(),
      endDate: new Date(),
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalReturn: 0,
      totalReturnPercent: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
      calmarRatio: 0,
      trades: []
    };
  }

  // Abstract methods to be implemented by concrete strategies
  protected abstract defineEntryConditions(): ConditionGroup;
  protected abstract defineExitConditions(): ConditionGroup;
  protected abstract calculateIndicators(context: MarketContext): Promise<Map<string, number | number[]>>;

  // Lifecycle Methods
  async initialize(): Promise<void> {
    try {
      this.logger.info(`Initializing strategy: ${this.name}`);
      
      // Set up entry and exit conditions if not defined in config
      if (!this.config.entryConditions.long.conditions.length) {
        this.config.entryConditions.long = this.defineEntryConditions();
      }
      
      if (!this.config.exitConditions.long.conditions.length) {
        this.config.exitConditions.long = this.defineExitConditions();
      }

      // Initialize market data storage
      for (const symbol of this.config.symbols) {
        this.marketData.set(symbol, []);
        this.currentPositions.set(symbol, 0);
      }

      this.state = 'ACTIVE';
      this.performance.startDate = new Date();
      
      this.emit('initialized', { strategyId: this.id });
      this.logger.info(`Strategy initialized successfully: ${this.name}`);
    } catch (error) {
      this.state = 'ERROR';
      this.logger.error(`Failed to initialize strategy: ${this.name}`, error);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    try {
      this.logger.info(`Shutting down strategy: ${this.name}`);
      this.state = 'INACTIVE';
      this.performance.endDate = new Date();
      this.updatePerformanceMetrics();
      this.emit('shutdown', { strategyId: this.id, performance: this.performance });
      this.removeAllListeners();
    } catch (error) {
      this.logger.error(`Error during strategy shutdown: ${this.name}`, error);
      throw error;
    }
  }

  // Market Data Processing
  async onBar(bar: Bar, context: MarketContext): Promise<Signal[]> {
    if (this.state !== 'ACTIVE') return [];

    try {
      // Store bar data
      const symbol = context.symbol;
      let bars = this.marketData.get(symbol) || [];
      bars.push(bar);
      
      // Keep only required number of bars (for performance)
      const maxBars = this.getMaxLookbackPeriod();
      if (bars.length > maxBars) {
        bars = bars.slice(-maxBars);
      }
      this.marketData.set(symbol, bars);

      // Update context with historical data
      context.previousBars = bars.slice(0, -1);
      context.indicators = await this.calculateIndicators(context);

      // Generate signals
      const signals = await this.generateSignals(context);
      
      if (signals.length > 0) {
        this.emit('signals', { strategyId: this.id, signals });
      }

      return signals;
    } catch (error) {
      this.logger.error(`Error processing bar for ${context.symbol}:`, error);
      return [];
    }
  }

  async onQuote(quote: Quote, context: MarketContext): Promise<Signal[]> {
    if (this.state !== 'ACTIVE') return [];

    try {
      // For most strategies, quotes are used for price updates but not signal generation
      // Override this method in strategies that need real-time quote processing
      return [];
    } catch (error) {
      this.logger.error(`Error processing quote for ${context.symbol}:`, error);
      return [];
    }
  }

  async onOrderFilled(order: any, context: MarketContext): Promise<void> {
    try {
      const symbol = order.Symbol || context.symbol;
      const quantity = parseFloat(order.Quantity || '0');
      const side = order.TradeAction;

      // Update position tracking
      let currentPosition = this.currentPositions.get(symbol) || 0;
      
      if (side === 'BUY' || side === 'BUYTOCOVER') {
        currentPosition += quantity;
      } else if (side === 'SELL' || side === 'SELLSHORT') {
        currentPosition -= quantity;
      }
      
      this.currentPositions.set(symbol, currentPosition);

      // Create trade record
      const trade: TradeRecord = {
        id: order.OrderID || `trade_${Date.now()}`,
        strategyId: this.id,
        symbol,
        entryDate: new Date(order.OpenedDateTime || Date.now()),
        exitDate: order.ClosedDateTime ? new Date(order.ClosedDateTime) : new Date(), // Fix undefined issue
        entryPrice: parseFloat(order.FilledPrice || '0'),
        exitPrice: order.ClosedDateTime ? parseFloat(order.FilledPrice || '0') : 0, // Fix undefined issue
        quantity,
        side: (side === 'BUY' || side === 'BUYTOCOVER') ? 'LONG' : 'SHORT',
        commission: parseFloat(order.CommissionFee || '0'),
        slippage: 0, // Calculate if needed
        entrySignal: this.createSignalFromOrder(order)
      };

      this.addTrade(trade);
      this.emit('orderFilled', { strategyId: this.id, order, trade });
    } catch (error) {
      this.logger.error('Error processing filled order:', error);
    }
  }

  // Signal Generation
  async generateSignals(context: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];

    try {
      const symbol = context.symbol;
      const currentPosition = this.currentPositions.get(symbol) || 0;

      // Check for entry signals
      if (currentPosition === 0) {
        // Check long entry
        if (await this.shouldEnterPosition(context, 'LONG')) {
          const signal = await this.createEntrySignal(context, 'BUY');
          if (signal) signals.push(signal);
        }

        // Check short entry (if enabled)
        if (this.config.entryConditions.short && 
            await this.shouldEnterPosition(context, 'SHORT')) {
          const signal = await this.createEntrySignal(context, 'SELL');
          if (signal) signals.push(signal);
        }
      }

      // Check for exit signals
      if (currentPosition !== 0) {
        if (await this.shouldExitPosition(context)) {
          const exitType = currentPosition > 0 ? 'CLOSE_LONG' : 'CLOSE_SHORT';
          const signal = await this.createExitSignal(context, exitType);
          if (signal) signals.push(signal);
        }
      }

      return signals;
    } catch (error) {
      this.logger.error('Error generating signals:', error);
      return [];
    }
  }

  // Position Management
  async shouldEnterPosition(context: MarketContext, side: 'LONG' | 'SHORT' = 'LONG'): Promise<boolean> {
    try {
      const conditions = side === 'LONG' ? 
        this.config.entryConditions.long : 
        this.config.entryConditions.short;

      if (!conditions) return false;

      // Check if enough time has passed since last signal
      const lastSignal = this.lastSignalTime.get(context.symbol);
      if (lastSignal) {
        const timeDiff = Date.now() - lastSignal.getTime();
        const minInterval = (typeof this.config.timeframe === 'string' ? 1 : this.config.timeframe.interval) * 60 * 1000; // Convert to milliseconds
        if (timeDiff < minInterval) return false;
      }

      // Evaluate entry conditions
      const result = await this.conditionEvaluator.evaluate(conditions, context);
      
      if (result) {
        this.lastSignalTime.set(context.symbol, new Date());
      }

      return result;
    } catch (error) {
      this.logger.error('Error evaluating entry conditions:', error);
      return false;
    }
  }

  async shouldExitPosition(context: MarketContext): Promise<boolean> {
    try {
      const currentPosition = this.currentPositions.get(context.symbol) || 0;
      if (currentPosition === 0) return false;

      const conditions = currentPosition > 0 ? 
        this.config.exitConditions.long : 
        this.config.exitConditions.short;

      if (!conditions) return false;

      return await this.conditionEvaluator.evaluate(conditions, context);
    } catch (error) {
      this.logger.error('Error evaluating exit conditions:', error);
      return false;
    }
  }

  calculatePositionSize(signal: Signal, context: MarketContext): number {
    try {
      const { method, baseAmount, riskPerTrade } = this.config.positionSizing;
      const { maxPositionSize, maxPositionSizeType } = this.config.riskManagement;

      let positionSize = 0;

      switch (method) {
        case 'fixed':
          positionSize = baseAmount;
          break;

        case 'percentage':
          positionSize = context.portfolioValue * (baseAmount / 100);
          break;

        case 'volatility':
          // ATR-based position sizing
          const atr = context.indicators.get('atr') as number || 0;
          if (atr > 0 && riskPerTrade) {
            const riskAmount = context.portfolioValue * (riskPerTrade / 100);
            positionSize = riskAmount / atr;
          } else {
            positionSize = baseAmount;
          }
          break;

        case 'kelly':
          // Kelly Criterion (simplified)
          const winRate = this.performance.winRate;
          const avgWin = this.performance.averageWin;
          const avgLoss = Math.abs(this.performance.averageLoss);
          
          if (avgLoss > 0 && winRate > 0) {
            const kellyPercent = (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin;
            positionSize = context.portfolioValue * Math.max(0, Math.min(kellyPercent, 0.25)); // Cap at 25%
          } else {
            positionSize = baseAmount;
          }
          break;

        default:
          positionSize = baseAmount;
      }

      // Apply maximum position size limits
      let maxSize = maxPositionSize;
      if (maxPositionSizeType === 'percentage') {
        maxSize = context.portfolioValue * (maxPositionSize / 100);
      } else if (maxPositionSizeType === 'shares') {
        maxSize = maxPositionSize * signal.price;
      }

      positionSize = Math.min(positionSize, maxSize);

      // Convert to shares
      const shares = Math.floor(positionSize / signal.price);
      
      return Math.max(1, shares); // Minimum 1 share
    } catch (error) {
      this.logger.error('Error calculating position size:', error);
      return 1;
    }
  }

  // Risk Management
  checkRiskLimits(signal: Signal, context: MarketContext): boolean {
    try {
      const { maxDailyLoss, maxDrawdown } = this.config.riskManagement;

      // Check daily loss limit
      if (maxDailyLoss) {
        const todaysPnL = this.calculateTodaysPnL();
        if (todaysPnL <= -maxDailyLoss) {
          this.logger.warn(`Daily loss limit reached: ${todaysPnL}`);
          return false;
        }
      }

      // Check maximum drawdown
      if (maxDrawdown) {
        const currentDrawdown = this.calculateCurrentDrawdown();
        if (currentDrawdown >= maxDrawdown) {
          this.logger.warn(`Maximum drawdown reached: ${currentDrawdown}%`);
          return false;
        }
      }

      // Check available cash
      const positionValue = signal.quantity * signal.price;
      if (positionValue > context.availableCash) {
        this.logger.warn(`Insufficient cash for trade: ${positionValue} > ${context.availableCash}`);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('Error checking risk limits:', error);
      return false;
    }
  }

  // Performance Tracking
  getPerformance(): StrategyPerformance {
    this.updatePerformanceMetrics();
    return { ...this.performance };
  }

  addTrade(trade: TradeRecord): void {
    this.trades.push(trade);
    this.performance.trades.push(trade);
    this.updatePerformanceMetrics();
    this.emit('tradeAdded', { strategyId: this.id, trade });
  }

  // Private Helper Methods
  private async createEntrySignal(context: MarketContext, type: 'BUY' | 'SELL'): Promise<Signal | null> {
    try {
      const signal: Signal = {
        id: `${this.id}_${context.symbol}_${Date.now()}`,
        symbol: context.symbol,
        type: type === 'BUY' ? 'BUY' : 'SELL',
        timestamp: new Date(),
        price: parseFloat(context.currentBar.Close),
        quantity: 0, // Will be calculated later
        confidence: 0.8, // Default confidence
        reason: `Entry signal from strategy: ${this.name}`,
        metadata: {
          strategyId: this.id,
          bar: context.currentBar,
          indicators: Object.fromEntries(context.indicators)
        }
      };

      signal.quantity = this.calculatePositionSize(signal, context);

      if (!this.checkRiskLimits(signal, context)) {
        return null;
      }

      return signal;
    } catch (error) {
      this.logger.error('Error creating entry signal:', error);
      return null;
    }
  }

  private async createExitSignal(context: MarketContext, type: SignalType): Promise<Signal | null> {
    try {
      const currentPosition = Math.abs(this.currentPositions.get(context.symbol) || 0);
      
      const signal: Signal = {
        id: `${this.id}_${context.symbol}_exit_${Date.now()}`,
        symbol: context.symbol,
        type,
        timestamp: new Date(),
        price: parseFloat(context.currentBar.Close),
        quantity: currentPosition,
        confidence: 0.9, // Higher confidence for exits
        reason: `Exit signal from strategy: ${this.name}`,
        metadata: {
          strategyId: this.id,
          bar: context.currentBar,
          indicators: Object.fromEntries(context.indicators)
        }
      };

      return signal;
    } catch (error) {
      this.logger.error('Error creating exit signal:', error);
      return null;
    }
  }

  private createSignalFromOrder(order: any): Signal {
    return {
      id: `signal_${order.OrderID}`,
      symbol: order.Symbol,
      type: order.TradeAction,
      timestamp: new Date(order.OpenedDateTime),
      price: parseFloat(order.FilledPrice || '0'),
      quantity: parseFloat(order.Quantity || '0'),
      confidence: 1.0,
      reason: 'Order execution',
      metadata: { orderId: order.OrderID }
    };
  }

  private updatePerformanceMetrics(): void {
    const completedTrades = this.trades.filter(t => t.exitDate && t.pnl !== undefined);
    
    this.performance.totalTrades = completedTrades.length;
    this.performance.winningTrades = completedTrades.filter(t => (t.pnl || 0) > 0).length;
    this.performance.losingTrades = completedTrades.filter(t => (t.pnl || 0) < 0).length;
    this.performance.winRate = this.performance.totalTrades > 0 ? 
      this.performance.winningTrades / this.performance.totalTrades : 0;

    const totalPnL = completedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    this.performance.totalReturn = totalPnL;

    if (this.performance.winningTrades > 0) {
      this.performance.averageWin = completedTrades
        .filter(t => (t.pnl || 0) > 0)
        .reduce((sum, t) => sum + (t.pnl || 0), 0) / this.performance.winningTrades;
    }

    if (this.performance.losingTrades > 0) {
      this.performance.averageLoss = completedTrades
        .filter(t => (t.pnl || 0) < 0)
        .reduce((sum, t) => sum + (t.pnl || 0), 0) / this.performance.losingTrades;
    }

    const grossProfit = completedTrades.filter(t => (t.pnl || 0) > 0).reduce((sum, t) => sum + (t.pnl || 0), 0);
    const grossLoss = Math.abs(completedTrades.filter(t => (t.pnl || 0) < 0).reduce((sum, t) => sum + (t.pnl || 0), 0));
    
    this.performance.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
  }

  private calculateTodaysPnL(): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    return this.trades
      .filter(t => t.exitDate && t.exitDate >= today)
      .reduce((sum, t) => sum + (t.pnl || 0), 0);
  }

  private calculateCurrentDrawdown(): number {
    // Simplified drawdown calculation
    const runningPnL = this.trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const peak = Math.max(0, runningPnL);
    return peak > 0 ? ((peak - runningPnL) / peak) * 100 : 0;
  }

  protected getMaxLookbackPeriod(): number {
    // Return the maximum lookback period needed by any indicator or condition
    // This should be overridden by specific strategies
    return 200; // Default to 200 bars
  }

  // State Management
  getState(): StrategyState {
    return this.state;
  }

  pause(): void {
    if (this.state === 'ACTIVE') {
      this.state = 'PAUSED';
      this.emit('paused', { strategyId: this.id });
    }
  }

  resume(): void {
    if (this.state === 'PAUSED') {
      this.state = 'ACTIVE';
      this.emit('resumed', { strategyId: this.id });
    }
  }

  updateConfig(newConfig: Partial<StrategyConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('configUpdated', { strategyId: this.id, config: this.config });
  }
}