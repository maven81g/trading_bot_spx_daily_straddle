// TradeStation API Types

export interface TradeStationConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  sandbox?: boolean;
}

export interface AuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  timestamp?: number;
}

// Bar/Candlestick Data
export interface Bar {
  Close: string;
  High: string;
  Low: string;
  Open: string;
  TimeStamp: string;
  TotalVolume: string;
  DownTicks?: number;
  DownVolume?: number;
  UpTicks?: number;
  UpVolume?: number;
  Epoch: number;
  IsRealtime: boolean;
  IsEndOfHistory: boolean;
  BarStatus: 'Open' | 'Closed';
}

export interface BarsResponse {
  Bars: Bar[];
}

// Quote Data
export interface Quote {
  Symbol: string;
  Ask: string;
  AskSize: string;
  Bid: string;
  BidSize: string;
  Last: string;
  High: string;
  Low: string;
  Open: string;
  Close: string;
  Volume: string;
  NetChange: string;
  NetChangePct: string;
  PreviousClose: string;
  TradeTime: string;
  MarketFlags: {
    IsDelayed: boolean;
    IsHalted: boolean;
    IsHardToBorrow: boolean;
    IsBats: boolean;
  };
}

// Account Information
export interface Account {
  AccountID: string;
  AccountType: 'Cash' | 'Margin' | 'Futures' | 'DVP';
  Currency: string;
  Status: string;
  AccountDetail?: {
    DayTradingQualified: boolean;
    OptionApprovalLevel: number;
    PatternDayTrader: boolean;
    RequiresBuyingPowerWarning: boolean;
  };
}

export interface Balance {
  AccountID: string;
  AccountType: string;
  CashBalance: string;
  BuyingPower: string;
  Equity: string;
  MarketValue: string;
  TodaysProfitLoss: string;
  UnclearedDeposit: string;
}

// Position Information
export interface Position {
  AccountID: string;
  Symbol: string;
  Quantity: string;
  AveragePrice: string;
  MarketValue: string;
  UnrealizedProfitLoss: string;
  UnrealizedProfitLossPercent: string;
  UnrealizedPnL?: string; // Alias for compatibility
  LongShort: 'Long' | 'Short';
  AssetType: 'STOCK' | 'STOCKOPTION' | 'FUTURE' | 'INDEXOPTION';
  Last: string;
  LastPrice: string;
  Bid: string;
  Ask: string;
  TodaysProfitLoss: string;
}

// Order Types
export type OrderType = 'Market' | 'Limit' | 'StopMarket' | 'StopLimit';
export type TradeAction = 'BUY' | 'SELL' | 'BUYTOCOVER' | 'SELLSHORT' | 
  'BUYTOOPEN' | 'BUYTOCLOSE' | 'SELLTOOPEN' | 'SELLTOCLOSE';
export type Duration = 'DAY' | 'GTC' | 'IOC' | 'FOK';

export interface OrderRequest {
  AccountID: string;
  Symbol: string;
  Quantity: string;
  OrderType: OrderType;
  TradeAction: TradeAction;
  TimeInForce: {
    Duration: Duration;
    Expiration?: string;
  };
  LimitPrice?: string;
  StopPrice?: string;
  Route?: string;
  AdvancedOptions?: {
    TrailingStop?: {
      Amount?: string;
      Percent?: string;
    };
    AllOrNone?: boolean;
    ShowOnlyQuantity?: string;
  };
}

export interface OrderResponse {
  OrderID?: string;
  Message?: string;
  Error?: string;
  Orders?: Array<{
    OrderID: string;
    Message: string;
  }>;
}

export interface Order {
  AccountID: string;
  OrderID: string;
  Symbol: string;
  OrderType: OrderType;
  TradeAction: TradeAction;
  Quantity: string;
  FilledQuantity?: string;
  RemainingQuantity?: string;
  LimitPrice?: string;
  StopPrice?: string;
  Status: string;
  StatusDescription: string;
  OpenedDateTime: string;
  ClosedDateTime?: string;
  Duration: string;
  Routing: string;
  CommissionFee: string;
}

// Streaming Data Types
export interface StreamMessage {
  MessageType: 'Bar' | 'Quote' | 'Heartbeat' | 'Error';
}

export interface StreamBar extends StreamMessage {
  MessageType: 'Bar';
  Symbol?: string;
  Close: string;
  High: string;
  Low: string;
  Open: string;
  TimeStamp: string;
  TotalVolume: string;
  DownTicks?: number;
  DownVolume?: number;
  UpTicks?: number;
  UpVolume?: number;
  Epoch: number;
  IsRealtime: boolean;
  IsEndOfHistory: boolean;
  BarStatus: 'Open' | 'Closed';
}

export interface StreamQuote extends StreamMessage {
  MessageType: 'Quote';
  Symbol: string;
  Ask: string;
  AskSize: string;
  Bid: string;
  BidSize: string;
  Last: string;
  High: string;
  Low: string;
  Open: string;
  Close: string;
  Volume: string;
  NetChange: string;
  NetChangePct: string;
  PreviousClose: string;
  TradeTime: string;
  MarketFlags: {
    IsDelayed: boolean;
    IsHalted: boolean;
    IsHardToBorrow: boolean;
    IsBats: boolean;
  };
}

export interface StreamHeartbeat extends StreamMessage {
  MessageType: 'Heartbeat';
  Heartbeat: number;
  Timestamp: string;
}

export interface StreamError extends StreamMessage {
  MessageType: 'Error';
  Error: string;
  Message: string;
}

export type StreamData = StreamBar | StreamQuote | StreamHeartbeat | StreamError;

// API Response Wrappers
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  nextToken?: string;
  hasMore: boolean;
}

// Bar Chart Parameters
export interface BarChartParams {
  symbol: string;
  interval?: number;
  unit?: 'Minute' | 'Daily' | 'Weekly' | 'Monthly';
  barsback?: number;
  firstdate?: string;
  lastdate?: string;
  sessiontemplate?: string;
}

// Symbol Details
export interface SymbolDetail {
  Symbol: string;
  Description: string;
  AssetType: string;
  Exchange: string;
  Currency: string;
  Country: string;
  PriceFormat: {
    Format: 'Decimal' | 'Fraction' | 'SubFraction';
    Decimals?: string;
    Fraction?: string;
    SubFraction?: string;
    Increment: string;
    PointValue: string;
  };
  QuantityFormat: {
    Format: 'Decimal';
    Decimals: string;
    Increment: string;
    MinimumTradeQuantity: string;
  };
}