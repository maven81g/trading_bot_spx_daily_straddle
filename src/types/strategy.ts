// Strategy and Condition Types

import { Bar, Quote, Position, OrderRequest } from './tradestation';

// Base Condition Interface
export interface ICondition {
  id: string;
  name: string;
  description: string;
  evaluate(context: MarketContext): boolean;
  getRequiredData(): string[]; // What data this condition needs (symbols, timeframes, etc.)
}

// Market Context for Condition Evaluation
export interface MarketContext {
  currentBar: Bar;
  previousBars: Bar[];
  currentQuote: Quote;
  positions: Position[];
  portfolioValue: number;
  availableCash: number;
  timestamp: Date;
  symbol: string;
  // Technical indicators cache
  indicators: Map<string, number | number[]>;
}

// Condition Types
export type ConditionType = 
  | 'price' 
  | 'volume' 
  | 'technical' 
  | 'time' 
  | 'position' 
  | 'risk' 
  | 'portfolio';

// Comparison Operators
export type ComparisonOperator = 
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  | 'between' | 'outside' | 'crosses_above' | 'crosses_below';

// Logical Operators for combining conditions
export type LogicalOperator = 'AND' | 'OR' | 'NOT';

// Base Condition Configuration
export interface ConditionConfig {
  id: string;
  type: ConditionType;
  name: string;
  description?: string;
  enabled: boolean;
  parameters: Record<string, any>;
}

// Price-based Conditions
export interface PriceConditionConfig extends ConditionConfig {
  type: 'price';
  parameters: {
    priceType: 'open' | 'high' | 'low' | 'close' | 'typical' | 'weighted';
    operator: ComparisonOperator;
    value: number;
    referenceType: 'absolute' | 'percentage' | 'previous_bar' | 'moving_average';
    lookbackPeriod?: number;
  };
}

// Volume-based Conditions
export interface VolumeConditionConfig extends ConditionConfig {
  type: 'volume';
  parameters: {
    operator: ComparisonOperator;
    value: number;
    referenceType: 'absolute' | 'percentage' | 'average' | 'previous_bar';
    lookbackPeriod?: number;
  };
}

// Technical Indicator Conditions
export interface TechnicalConditionConfig extends ConditionConfig {
  type: 'technical';
  parameters: {
    indicator: 'sma' | 'ema' | 'rsi' | 'macd' | 'bollinger' | 'stochastic' | 'atr';
    period: number;
    operator: ComparisonOperator;
    value: number;
    additionalParams?: Record<string, any>;
  };
}

// Time-based Conditions
export interface TimeConditionConfig extends ConditionConfig {
  type: 'time';
  parameters: {
    timeType: 'time_of_day' | 'day_of_week' | 'market_session' | 'duration_since';
    startTime?: string; // HH:MM format
    endTime?: string;   // HH:MM format
    daysOfWeek?: number[]; // 0-6, 0 = Sunday
    sessionType?: 'pre_market' | 'regular' | 'after_hours';
    duration?: number; // minutes
    referenceEvent?: 'market_open' | 'market_close' | 'position_entry';
  };
}

// Position-based Conditions
export interface PositionConditionConfig extends ConditionConfig {
  type: 'position';
  parameters: {
    positionType: 'has_position' | 'position_size' | 'unrealized_pnl' | 'position_age';
    symbol?: string;
    operator?: ComparisonOperator;
    value?: number;
    unit?: 'shares' | 'dollars' | 'percentage' | 'minutes' | 'hours' | 'days';
  };
}

// Condition Group for complex logic
export interface ConditionGroup {
  id: string;
  name: string;
  operator: LogicalOperator;
  conditions: (ConditionConfig | ConditionGroup)[];
}

// Signal Types
export type SignalType = 'BUY' | 'SELL' | 'HOLD' | 'CLOSE_LONG' | 'CLOSE_SHORT';

export interface Signal {
  id: string;
  symbol: string;
  type: SignalType;
  timestamp: Date;
  price: number;
  quantity: number;
  confidence: number; // 0-1
  reason: string;
  metadata?: Record<string, any>;
}

// Strategy Configuration
export interface StrategyConfig {
  id: string;
  name: string;
  type: string;
  description?: string;
  enabled: boolean;
  symbols: string[];
  timeframe: string | {
    interval: number;
    unit: 'Minute' | 'Daily' | 'Weekly' | 'Monthly';
  };
  parameters: any;
  
  // Entry and Exit Conditions
  entryConditions: {
    long: ConditionGroup;
    short?: ConditionGroup;
  };
  
  exitConditions: {
    long: ConditionGroup;
    short?: ConditionGroup;
  };
  
  // Risk Management
  riskManagement: {
    maxPositionSize: number; // Maximum position size in dollars or shares
    maxPositionSizeType: 'dollars' | 'shares' | 'percentage'; // percentage of portfolio
    stopLoss?: {
      type: 'percentage' | 'dollars' | 'atr_multiple';
      value: number;
    };
    takeProfit?: {
      type: 'percentage' | 'dollars' | 'risk_reward_ratio';
      value: number;
    };
    maxDailyLoss?: number; // Maximum daily loss in dollars
    maxDrawdown?: number; // Maximum drawdown percentage
  };
  
  // Position Sizing
  positionSizing: {
    method: 'fixed' | 'percentage' | 'volatility' | 'kelly';
    baseAmount: number;
    riskPerTrade?: number; // Risk per trade as percentage of portfolio
  };
  
  // Execution Settings
  execution: {
    orderType: 'Market' | 'Limit' | 'StopMarket' | 'StopLimit';
    timeInForce: 'DAY' | 'GTC' | 'IOC' | 'FOK';
    limitOffset?: number; // For limit orders, offset from current price
    maxSlippage?: number; // Maximum acceptable slippage percentage
  };
}

// Strategy Performance Metrics
export interface StrategyPerformance {
  strategyId: string;
  symbol: string;
  startDate: Date;
  endDate: Date;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalReturn: number;
  totalReturnPercent: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  calmarRatio: number;
  trades: TradeRecord[];
}

export interface TradeRecord {
  id: string;
  strategyId: string;
  symbol: string;
  entryDate: Date;
  exitDate?: Date;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  side: 'LONG' | 'SHORT';
  pnl?: number;
  pnlPercent?: number;
  duration?: number; // in minutes
  entrySignal: Signal;
  exitSignal?: Signal;
  commission: number;
  slippage: number;
}

// Strategy Events
export interface StrategyEvent {
  id: string;
  strategyId: string;
  timestamp: Date;
  type: 'SIGNAL' | 'ORDER' | 'FILL' | 'ERROR' | 'WARNING';
  symbol: string;
  message: string;
  data?: any;
}

// Portfolio Allocation
export interface PortfolioAllocation {
  strategyId: string;
  symbol: string;
  allocationPercent: number; // Percentage of portfolio allocated to this strategy/symbol
  maxPositionSize: number;
  currentPositionSize: number;
  availableCapital: number;
}

// Base Strategy Interface
export interface IStrategy {
  id: string;
  name: string;
  config: StrategyConfig;
  
  // Lifecycle methods
  initialize(): Promise<void>;
  onBar(bar: Bar, context: MarketContext): Promise<Signal[]>;
  onQuote(quote: Quote, context: MarketContext): Promise<Signal[]>;
  onOrderFilled(order: any, context: MarketContext): Promise<void>;
  shutdown(): Promise<void>;
  
  // Signal generation
  generateSignals(context: MarketContext): Promise<Signal[]>;
  
  // Position management
  shouldEnterPosition(context: MarketContext): Promise<boolean>;
  shouldExitPosition(context: MarketContext): Promise<boolean>;
  calculatePositionSize(signal: Signal, context: MarketContext): number;
  
  // Risk management
  checkRiskLimits(signal: Signal, context: MarketContext): boolean;
  
  // Performance tracking
  getPerformance(): StrategyPerformance;
  addTrade(trade: TradeRecord): void;
}

export type StrategyState = 'INACTIVE' | 'ACTIVE' | 'PAUSED' | 'ERROR';