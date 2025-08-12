// Mock TradeStation Client for Testing
// This allows testing strategies without making real API calls

import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { 
  TradeStationConfig, 
  AuthToken, 
  ApiResponse,
  Account,
  Balance,
  Position,
  Order,
  OrderRequest,
  OrderResponse,
  BarChartParams,
  BarsResponse,
  Quote,
  SymbolDetail,
  Bar
} from '@/types/tradestation';
import { createLogger } from '@/utils/logger';

export interface MockTradeStationConfig extends TradeStationConfig {
  mockMode: boolean;
  initialBalance?: number;
  initialSPXPrice?: number;
}

export class MockTradeStationClient extends EventEmitter {
  private config: MockTradeStationConfig;
  private logger: Logger;
  private authToken: AuthToken | null = null;
  private mockBalance: number;
  private mockPositions: Map<string, Position> = new Map();
  private mockOrders: Map<string, Order> = new Map();
  private currentSPXPrice: number;
  private orderIdCounter: number = 1;

  constructor(config: MockTradeStationConfig) {
    super();
    this.config = config;
    this.logger = createLogger('MockTradeStationClient');
    this.mockBalance = config.initialBalance || 50000;
    this.currentSPXPrice = config.initialSPXPrice || 5800;
    
    // Auto-authenticate in mock mode
    this.authToken = {
      access_token: 'mock_access_token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'mock_refresh_token',
      scope: config.scope
    };
    
    this.logger.info('Mock TradeStation client initialized');
  }

  // Authentication Methods
  async authenticate(authCode: string): Promise<ApiResponse<AuthToken>> {
    this.logger.info('Mock authentication successful');
    this.emit('authenticated', this.authToken);
    return { success: true, data: this.authToken! };
  }

  async refreshToken(): Promise<ApiResponse<AuthToken>> {
    this.logger.info('Mock token refresh successful');
    this.emit('tokenRefreshed', this.authToken);
    return { success: true, data: this.authToken! };
  }

  getAuthUrl(): string {
    return 'https://mock-auth-url.com';
  }

  // Account Methods
  async getAccounts(): Promise<ApiResponse<Account[]>> {
    const mockAccounts: Account[] = [
      {
        AccountID: 'MOCK123456',
        Name: 'Mock Trading Account',
        AccountType: 'Cash',
        Status: 'Active',
        Currency: 'USD'
      }
    ];
    return { success: true, data: mockAccounts };
  }

  async getBalances(accountIds: string[]): Promise<ApiResponse<Balance[]>> {
    const mockBalances: Balance[] = [
      {
        AccountID: accountIds[0] || 'MOCK123456',
        TotalCash: this.mockBalance,
        AvailableCash: this.mockBalance * 0.9, // 90% available
        MarketValue: this.mockBalance + this.calculatePositionsValue(),
        Equity: this.mockBalance + this.calculatePositionsValue(),
        Currency: 'USD'
      }
    ];
    return { success: true, data: mockBalances };
  }

  async getPositions(accountIds: string[], symbol?: string): Promise<ApiResponse<Position[]>> {
    const positions = Array.from(this.mockPositions.values());
    const filteredPositions = symbol ? 
      positions.filter(p => p.Symbol === symbol) : 
      positions;
    return { success: true, data: filteredPositions };
  }

  async getOrders(accountIds: string[]): Promise<ApiResponse<Order[]>> {
    const orders = Array.from(this.mockOrders.values());
    return { success: true, data: orders };
  }

  // Market Data Methods - Generate mock SPX data
  async getBars(params: BarChartParams): Promise<ApiResponse<BarsResponse>> {
    if (params.symbol === '$SPXW.X') {
      const bars = this.generateMockSPXBars(params.barsback || 100);
      const response: BarsResponse = {
        Bars: bars,
        Symbol: params.symbol,
        Response: 'Success'
      };
      return { success: true, data: response };
    }
    
    // For other symbols, return empty data
    return { 
      success: true, 
      data: { Bars: [], Symbol: params.symbol, Response: 'No Data' } 
    };
  }

  async getQuotes(symbols: string[]): Promise<ApiResponse<Quote[]>> {
    const quotes: Quote[] = symbols.map(symbol => {
      if (symbol === '$SPXW.X') {
        return {
          Symbol: symbol,
          Bid: this.currentSPXPrice - 0.25,
          Ask: this.currentSPXPrice + 0.25,
          Last: this.currentSPXPrice,
          Volume: 1000000,
          Timestamp: new Date().toISOString()
        };
      } else if (symbol.startsWith('SPXW')) {
        // Mock option pricing
        const optionPrice = this.calculateMockOptionPrice(symbol);
        return {
          Symbol: symbol,
          Bid: optionPrice - 0.05,
          Ask: optionPrice + 0.05,
          Last: optionPrice,
          Volume: 100,
          Timestamp: new Date().toISOString()
        };
      }
      
      return {
        Symbol: symbol,
        Bid: 100,
        Ask: 100.05,
        Last: 100.025,
        Volume: 1000,
        Timestamp: new Date().toISOString()
      };
    });
    
    return { success: true, data: quotes };
  }

  async getSymbolDetails(symbols: string[]): Promise<ApiResponse<SymbolDetail[]>> {
    const details: SymbolDetail[] = symbols.map(symbol => ({
      Symbol: symbol,
      Name: `Mock ${symbol}`,
      Exchange: 'MOCK',
      Category: symbol.startsWith('SPXW') ? 'Option' : 'Index',
      Currency: 'USD'
    }));
    
    return { success: true, data: details };
  }

  // Order Execution Methods
  async placeOrder(order: OrderRequest): Promise<ApiResponse<OrderResponse>> {
    const orderId = `MOCK_${this.orderIdCounter++}`;
    const fillPrice = await this.getMockFillPrice(order.Symbol);
    
    // Simulate order execution
    const mockOrder: Order = {
      OrderID: orderId,
      Symbol: order.Symbol,
      Quantity: order.Quantity.toString(),
      TradeAction: order.TradeAction,
      OrderType: order.OrderType,
      Status: 'Filled',
      FilledPrice: fillPrice.toString(),
      OpenedDateTime: new Date().toISOString(),
      ClosedDateTime: new Date().toISOString()
    };
    
    this.mockOrders.set(orderId, mockOrder);
    
    // Update positions and balance
    this.updateMockPosition(mockOrder);
    
    this.logger.info(`Mock order executed: ${order.TradeAction} ${order.Quantity} ${order.Symbol} at $${fillPrice}`);
    
    const response: OrderResponse = {
      OrderID: orderId,
      Status: 'Filled',
      Message: 'Order executed successfully'
    };
    
    // Emit order filled event after a short delay
    setTimeout(() => {
      this.emit('orderFilled', mockOrder);
    }, 100);
    
    return { success: true, data: response };
  }

  async cancelOrder(orderId: string): Promise<ApiResponse<OrderResponse>> {
    const order = this.mockOrders.get(orderId);
    if (order) {
      order.Status = 'Cancelled';
      this.logger.info(`Mock order cancelled: ${orderId}`);
    }
    
    return { 
      success: true, 
      data: { OrderID: orderId, Status: 'Cancelled', Message: 'Order cancelled' } 
    };
  }

  async replaceOrder(orderId: string, modifications: Partial<OrderRequest>): Promise<ApiResponse<OrderResponse>> {
    return { 
      success: true, 
      data: { OrderID: orderId, Status: 'Replaced', Message: 'Order replaced' } 
    };
  }

  async confirmOrder(order: OrderRequest): Promise<ApiResponse<any>> {
    return { 
      success: true, 
      data: { Message: 'Order confirmed', EstimatedCost: 100 } 
    };
  }

  // Mock Data Generation
  private generateMockSPXBars(count: number): Bar[] {
    const bars: Bar[] = [];
    let currentPrice = this.currentSPXPrice;
    const now = new Date();
    
    for (let i = count - 1; i >= 0; i--) {
      const timestamp = new Date(now.getTime() - (i * 60 * 1000)); // 1-minute bars
      
      // Generate realistic price movement
      const volatility = 0.002; // 0.2% volatility
      const change = (Math.random() - 0.5) * volatility * currentPrice;
      currentPrice += change;
      
      const high = currentPrice + Math.random() * 2;
      const low = currentPrice - Math.random() * 2;
      const open = currentPrice + (Math.random() - 0.5) * 1;
      const close = currentPrice;
      
      bars.push({
        TimeStamp: timestamp.toISOString(),
        Open: open.toFixed(2),
        High: Math.max(open, close, high).toFixed(2),
        Low: Math.min(open, close, low).toFixed(2),
        Close: close.toFixed(2),
        TotalVolume: Math.floor(Math.random() * 1000000).toString(),
        UpTicks: Math.floor(Math.random() * 1000),
        DownTicks: Math.floor(Math.random() * 1000),
        UnchangedTicks: Math.floor(Math.random() * 100),
        UpVolume: Math.floor(Math.random() * 500000),
        DownVolume: Math.floor(Math.random() * 500000),
        UnchangedVolume: Math.floor(Math.random() * 50000),
        TotalTicks: Math.floor(Math.random() * 2000),
        OpenInterest: '0',
        IsRealtime: true,
        IsEndOfHistory: i === 0,
        Epoch: timestamp.getTime(),
        BarStatus: 'Closed'
      });
    }
    
    // Update current price to last bar's close
    this.currentSPXPrice = parseFloat(bars[bars.length - 1].Close);
    return bars;
  }

  private calculateMockOptionPrice(symbol: string): number {
    // Parse strike from symbol (e.g., SPXW 250729C6370)
    const strikeMatch = symbol.match(/[CP](\d+)$/);
    if (!strikeMatch) return 1.0;
    
    const strike = parseInt(strikeMatch[1]);
    const isCall = symbol.includes('C');
    
    if (isCall) {
      // Simple call option pricing: max(0, spot - strike) + time value
      const intrinsic = Math.max(0, this.currentSPXPrice - strike);
      const timeValue = Math.random() * 5; // Random time value 0-5
      return Math.max(0.05, intrinsic + timeValue);
    } else {
      // Simple put option pricing: max(0, strike - spot) + time value
      const intrinsic = Math.max(0, strike - this.currentSPXPrice);
      const timeValue = Math.random() * 5;
      return Math.max(0.05, intrinsic + timeValue);
    }
  }

  private async getMockFillPrice(symbol: string): Promise<number> {
    if (symbol.startsWith('SPXW')) {
      return this.calculateMockOptionPrice(symbol);
    }
    return this.currentSPXPrice;
  }

  private updateMockPosition(order: Order): void {
    const symbol = order.Symbol;
    const quantity = parseFloat(order.Quantity);
    const price = parseFloat(order.FilledPrice || '0');
    const side = order.TradeAction;
    
    const existingPosition = this.mockPositions.get(symbol);
    
    if (existingPosition) {
      if ((side === 'BUY' && existingPosition.LongShort === 'Long') ||
          (side === 'SELL' && existingPosition.LongShort === 'Short')) {
        // Add to position
        existingPosition.Quantity = (parseFloat(existingPosition.Quantity) + quantity).toString();
      } else {
        // Reduce or close position
        const newQuantity = parseFloat(existingPosition.Quantity) - quantity;
        if (newQuantity <= 0) {
          this.mockPositions.delete(symbol);
        } else {
          existingPosition.Quantity = newQuantity.toString();
        }
      }
    } else {
      // New position
      const position: Position = {
        AccountID: 'MOCK123456',
        Symbol: symbol,
        Quantity: quantity.toString(),
        AveragePrice: price,
        MarketValue: quantity * price,
        UnrealizedPnL: 0,
        LongShort: side === 'BUY' ? 'Long' : 'Short'
      };
      this.mockPositions.set(symbol, position);
    }
    
    // Update balance (subtract cost for buys, add proceeds for sells)
    const cost = quantity * price * (symbol.startsWith('SPXW') ? 100 : 1); // Options are 100 multiplier
    if (side === 'BUY') {
      this.mockBalance -= cost;
    } else {
      this.mockBalance += cost;
    }
  }

  private calculatePositionsValue(): number {
    let totalValue = 0;
    for (const position of this.mockPositions.values()) {
      totalValue += position.MarketValue;
    }
    return totalValue;
  }

  // Utility Methods
  isAuthenticated(): boolean {
    return this.authToken !== null;
  }

  getToken(): AuthToken | null {
    return this.authToken;
  }

  async healthCheck(): Promise<boolean> {
    return true; // Always healthy in mock mode
  }

  // Test helpers
  setCurrentSPXPrice(price: number): void {
    this.currentSPXPrice = price;
    this.logger.info(`Mock SPX price set to: ${price}`);
  }

  getMockBalance(): number {
    return this.mockBalance;
  }

  getMockPositions(): Map<string, Position> {
    return new Map(this.mockPositions);
  }

  // Cleanup
  destroy(): void {
    this.removeAllListeners();
    this.authToken = null;
    this.mockPositions.clear();
    this.mockOrders.clear();
  }
}