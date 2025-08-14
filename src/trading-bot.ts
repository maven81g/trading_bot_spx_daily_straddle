// Consolidated Trading Bot - Combines SimpleBot monitoring with SimpleTradingBot strategy
// This is the main bot class that actually executes trades

import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { TradeStationClient } from './api/client';
import { TradeStationHttpStreaming } from './api/http-streaming';
import { createLogger } from './utils/logger';
import {
  TradeStationConfig,
  Account,
  Balance,
  Position,
  Bar,
  Quote,
  OrderRequest,
  OrderResponse
} from './types/tradestation';

export interface TradingBotConfig {
  tradeStation: TradeStationConfig & { streamingUrl?: string };
  strategy: {
    spxSymbol: string;
    macdFastPeriod: number;
    macdSlowPeriod: number;
    macdSignalPeriod: number;
    macdThreshold: number;
    profitTarget: number;
    stopLossPercentage: number;
  };
  trading: {
    paperTrading: boolean;
    maxPositions: number;
    accountId?: string;
  };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    file?: string;
  };
}

interface ActivePosition {
  symbol: string;
  entryPrice: number;
  entryTime: Date;
  quantity: number;
  spxPriceAtEntry: number;
  currentPrice?: number;
  unrealizedPnL?: number;
}

interface MACDValues {
  macd: number;
  signal: number;
  histogram: number;
  crossover: 'bullish' | 'bearish' | 'none';
}

export class TradingBot extends EventEmitter {
  private config: TradingBotConfig;
  private logger: Logger;
  private apiClient: TradeStationClient;
  private streamingClient: TradeStationHttpStreaming;
  private accounts: Account[] = [];
  private isRunning = false;
  
  // Status tracking
  private dailyPnL = 0;
  private totalTrades = 0;
  private activePositions: Position[] = [];
  private startTime: Date | null = null;
  
  // Strategy state
  private currentPosition: ActivePosition | null = null;
  private spxSubscriptionId: string | null = null;
  private optionSubscriptionId: string | null = null;
  
  // MACD calculation arrays
  private spxBars: Bar[] = [];
  private ema12: number[] = [];
  private ema26: number[] = [];
  private macdLine: number[] = [];
  private signalLine: number[] = [];
  private histogramHistory: number[] = [];
  
  // Previous values for crossover detection
  private previousMacd: number | null = null;
  private previousSignal: number | null = null;

  constructor(config: TradingBotConfig) {
    super();
    this.config = config;
    this.logger = createLogger('TradingBot', config.logging);
    
    this.apiClient = new TradeStationClient(config.tradeStation);
    this.streamingClient = new TradeStationHttpStreaming(config.tradeStation);
    
    this.setupEventListeners();
  }

  async start(): Promise<void> {
    try {
      this.logger.info('🚀 Starting Trading Bot...');
      
      // Step 1: Authenticate
      await this.authenticate();
      
      // Step 2: Load accounts
      await this.loadAccounts();
      
      // Step 3: Start streaming SPX data
      await this.startSpxStreaming();
      
      this.isRunning = true;
      this.startTime = new Date();
      this.logger.info('✅ Trading Bot started successfully');
      this.emit('started');
      
    } catch (error) {
      this.logger.error('❌ Failed to start Trading Bot:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      this.logger.info('🛑 Stopping Trading Bot...');
      
      // Close any open positions
      if (this.currentPosition) {
        await this.closePosition('Bot stopping');
      }
      
      // Stop streaming
      if (this.spxSubscriptionId) {
        await this.streamingClient.unsubscribe(this.spxSubscriptionId);
      }
      if (this.optionSubscriptionId) {
        await this.streamingClient.unsubscribe(this.optionSubscriptionId);
      }
      
      this.streamingClient.destroy();
      this.apiClient.destroy();
      
      this.isRunning = false;
      this.logger.info('✅ Trading Bot stopped');
      this.emit('stopped');
      
    } catch (error) {
      this.logger.error('❌ Error stopping Trading Bot:', error);
      this.emit('error', error);
      throw error;
    }
  }

  private async authenticate(): Promise<void> {
    const refreshToken = process.env.TRADESTATION_REFRESH_TOKEN;
    if (!refreshToken) {
      throw new Error('TRADESTATION_REFRESH_TOKEN is required');
    }

    const success = await this.apiClient.authenticateWithRefreshToken(refreshToken);
    if (!success) {
      throw new Error('Authentication failed');
    }

    this.logger.info('✅ Authentication successful');
  }

  private async loadAccounts(): Promise<void> {
    const response = await this.apiClient.getAccounts();
    if (!response.success || !response.data) {
      throw new Error('Failed to load accounts');
    }

    this.accounts = response.data;
    
    // Select trading account
    const tradingAccount = this.config.trading.accountId 
      ? this.accounts.find(a => a.AccountID === this.config.trading.accountId)
      : this.accounts[0];
      
    if (!tradingAccount) {
      throw new Error('No trading account found');
    }
    
    this.logger.info(`✅ Using account: ${tradingAccount.AccountID} (${tradingAccount.AccountType})`);
  }

  private async startSpxStreaming(): Promise<void> {
    try {
      // Subscribe to SPX bars
      this.spxSubscriptionId = await this.streamingClient.subscribeToBars({
        symbol: this.config.strategy.spxSymbol,
        interval: 1,
        unit: 'Minute'
      });
      
      this.logger.info(`✅ Streaming SPX data: ${this.config.strategy.spxSymbol}`);
      
    } catch (error) {
      this.logger.error('Failed to start SPX streaming:', error);
      throw error;
    }
  }

  private async onSpxBar(bar: Bar): Promise<void> {
    try {
      // Add bar to history
      this.spxBars.push(bar);
      
      // Keep only last 100 bars for MACD calculation
      if (this.spxBars.length > 100) {
        this.spxBars.shift();
      }
      
      // Need at least 26 bars for MACD
      if (this.spxBars.length < 26) {
        return;
      }
      
      // Calculate MACD
      const macd = this.calculateMACD();
      
      // Check for signals
      if (!this.currentPosition) {
        await this.checkEntrySignal(macd, bar);
      } else {
        await this.checkExitSignal(macd, bar);
      }
      
    } catch (error) {
      this.logger.error('Error processing SPX bar:', error);
    }
  }

  private calculateMACD(): MACDValues {
    const closes = this.spxBars.map(b => parseFloat(b.Close));
    
    // Calculate EMAs
    const ema12 = this.calculateEMA(closes, this.config.strategy.macdFastPeriod);
    const ema26 = this.calculateEMA(closes, this.config.strategy.macdSlowPeriod);
    
    // MACD line
    const macd = ema12 - ema26;
    
    // Signal line (9-period EMA of MACD)
    this.macdLine.push(macd);
    if (this.macdLine.length > 50) this.macdLine.shift();
    
    const signal = this.calculateEMA(this.macdLine, this.config.strategy.macdSignalPeriod);
    
    // Histogram
    const histogram = macd - signal;
    
    // Detect crossover
    let crossover: 'bullish' | 'bearish' | 'none' = 'none';
    if (this.previousMacd !== null && this.previousSignal !== null) {
      if (this.previousMacd <= this.previousSignal && macd > signal) {
        crossover = 'bullish';
      } else if (this.previousMacd >= this.previousSignal && macd < signal) {
        crossover = 'bearish';
      }
    }
    
    this.previousMacd = macd;
    this.previousSignal = signal;
    
    return { macd, signal, histogram, crossover };
  }

  private calculateEMA(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1];
    
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b) / period;
    
    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }
    
    return ema;
  }

  private async checkEntrySignal(macd: MACDValues, bar: Bar): Promise<void> {
    // Entry conditions (matching backtest exactly):
    // 1. MACD is below threshold (oversold)
    // 2. Bullish crossover detected
    // 3. Histogram is increasing over last 4 bars
    // 4. Within trading hours (9:35 AM - 3:30 PM ET)
    
    // Check trading hours (9:35 AM - 3:30 PM ET)
    if (!this.isWithinEntryHours(bar.TimeStamp)) {
      return;
    }
    
    // Check all entry conditions
    if (macd.macd <= this.config.strategy.macdThreshold && 
        macd.crossover === 'bullish' &&
        this.isHistogramIncreasing(macd.histogram)) {
      
      this.logger.info(`📈 Entry signal detected: Bullish MACD crossover with increasing histogram`);
      this.logger.info(`   SPX: ${bar.Close}, MACD: ${macd.macd.toFixed(4)}, Signal: ${macd.signal.toFixed(4)}, Hist: ${macd.histogram.toFixed(4)}`);
      this.logger.info(`   Last 4 histograms: ${[...this.histogramHistory.slice(-3), macd.histogram].map(h => h.toFixed(4)).join(', ')}`);
      
      // Find appropriate option strike (round DOWN to nearest 5, matching backtest)
      const strike = Math.floor(parseFloat(bar.Close) / 5) * 5; // Round DOWN to nearest 5
      await this.enterPosition(strike, parseFloat(bar.Close));
    }
    
    // Always track histogram for trend analysis
    this.histogramHistory.push(macd.histogram);
    if (this.histogramHistory.length > 10) this.histogramHistory.shift();
  }

  private async checkExitSignal(macd: MACDValues, bar: Bar): Promise<void> {
    if (!this.currentPosition) return;
    
    // Get current option price
    const currentPrice = await this.getOptionPrice(this.currentPosition.symbol);
    if (!currentPrice) return;
    
    const pnl = (currentPrice - this.currentPosition.entryPrice) * this.currentPosition.quantity * 100;
    const pnlPercent = (currentPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice;
    
    // Exit conditions:
    // 1. Profit target reached
    // 2. Stop loss hit
    // 3. Bearish crossover
    // 4. Momentum reversal (histogram shrinking after profit)
    
    let exitReason: string | null = null;
    
    if (pnl >= this.config.strategy.profitTarget) {
      exitReason = 'Profit target reached';
      if (this.histogramHistory.length > 0 && 
          macd.histogram < this.histogramHistory[this.histogramHistory.length - 1]) {
        exitReason += ' AND momentum shrinking';
      }
    } else if (pnlPercent <= -this.config.strategy.stopLossPercentage) {
      exitReason = `Stop loss triggered (${(pnlPercent * 100).toFixed(1)}% loss)`;
    } else if (macd.crossover === 'bearish') {
      exitReason = 'Negative crossover signal (bearish MACD crossover)';
    }
    
    if (exitReason) {
      this.logger.info(`📉 Exit signal: ${exitReason}`);
      this.logger.info(`   P&L: $${pnl.toFixed(2)} (${(pnlPercent * 100).toFixed(1)}%)`);
      await this.closePosition(exitReason);
    }
  }
  
  /**
   * Check if histogram is increasing over last 4 bars (matching backtest logic)
   */
  private isHistogramIncreasing(currentHistogram: number): boolean {
    // Need at least 3 previous histogram values + current = 4 total
    if (this.histogramHistory.length < 3) {
      return false;
    }
    
    // Create array of last 3 previous values + current value
    const last4Values = [...this.histogramHistory.slice(-3), currentHistogram];
    
    // Check if each value is greater than the previous (increasing/becoming more bullish)
    for (let i = 1; i < last4Values.length; i++) {
      if (last4Values[i] <= last4Values[i - 1]) {
        return false; // Not strictly increasing
      }
    }
    
    return true; // All values are increasing
  }
  
  /**
   * Check if current time is within trading hours (9:35 AM - 3:30 PM ET)
   */
  private isWithinEntryHours(timestamp: string): boolean {
    const date = new Date(timestamp);
    const hours = date.getUTCHours() - 5; // Convert to ET (rough, doesn't handle DST)
    const minutes = date.getUTCMinutes();
    const totalMinutes = hours * 60 + minutes;
    
    // 9:35 AM ET = 575 minutes, 3:30 PM ET = 930 minutes
    return totalMinutes >= 575 && totalMinutes <= 930;
  }

  private async enterPosition(strike: number, spxPrice: number): Promise<void> {
    try {
      // Generate option symbol (0DTE call)
      const expiry = new Date();
      const symbol = this.generateOptionSymbol('SPXW', expiry, strike, 'C');
      
      // Get option quote
      const price = await this.getOptionPrice(symbol);
      if (!price) {
        this.logger.warn(`Could not get price for ${symbol}`);
        return;
      }
      
      // Create position
      this.currentPosition = {
        symbol,
        entryPrice: price,
        entryTime: new Date(),
        quantity: 1,
        spxPriceAtEntry: spxPrice
      };
      
      // Execute trade (paper or real)
      if (this.config.trading.paperTrading) {
        this.logger.info(`📝 PAPER TRADE - BUY ${symbol} @ $${price.toFixed(2)}`);
      } else {
        await this.executeTrade('BUY', symbol, 1, price);
      }
      
      // Start monitoring the option
      this.optionSubscriptionId = await this.streamingClient.subscribeToQuotes([symbol]);
      
      this.totalTrades++;
      this.emit('positionOpened', this.currentPosition);
      
    } catch (error) {
      this.logger.error('Error entering position:', error);
    }
  }

  private async closePosition(reason: string): Promise<void> {
    if (!this.currentPosition) return;
    
    try {
      const exitPrice = await this.getOptionPrice(this.currentPosition.symbol);
      if (!exitPrice) return;
      
      const pnl = (exitPrice - this.currentPosition.entryPrice) * this.currentPosition.quantity * 100;
      
      // Execute trade (paper or real)
      if (this.config.trading.paperTrading) {
        this.logger.info(`📝 PAPER TRADE - SELL ${this.currentPosition.symbol} @ $${exitPrice.toFixed(2)}`);
        this.logger.info(`   P&L: $${pnl.toFixed(2)} | Reason: ${reason}`);
      } else {
        await this.executeTrade('SELL', this.currentPosition.symbol, this.currentPosition.quantity, exitPrice);
      }
      
      // Update daily P&L
      this.dailyPnL += pnl;
      
      // Stop monitoring
      if (this.optionSubscriptionId) {
        await this.streamingClient.unsubscribe(this.optionSubscriptionId);
        this.optionSubscriptionId = null;
      }
      
      this.emit('positionClosed', { ...this.currentPosition, exitPrice, pnl, reason });
      this.currentPosition = null;
      
    } catch (error) {
      this.logger.error('Error closing position:', error);
    }
  }

  private onOptionQuote(quote: Quote): void {
    if (this.currentPosition) {
      this.currentPosition.currentPrice = parseFloat(quote.Last || quote.Bid || '0');
      this.currentPosition.unrealizedPnL = 
        (this.currentPosition.currentPrice - this.currentPosition.entryPrice) * 
        this.currentPosition.quantity * 100;
    }
  }

  private async getOptionPrice(symbol: string): Promise<number | null> {
    try {
      const response = await this.apiClient.getQuote(symbol);
      if (response.success && response.data) {
        return parseFloat(response.data.Last || response.data.Ask || response.data.Bid || '0') || null;
      }
      return null;
    } catch (error) {
      this.logger.error(`Error getting price for ${symbol}:`, error);
      return null;
    }
  }

  private generateOptionSymbol(underlying: string, expiry: Date, strike: number, type: 'C' | 'P'): string {
    const year = expiry.getFullYear().toString().slice(-2);
    const month = (expiry.getMonth() + 1).toString().padStart(2, '0');
    const day = expiry.getDate().toString().padStart(2, '0');
    return `${underlying} ${year}${month}${day}${type}${strike}`;
  }

  private async executeTrade(side: 'BUY' | 'SELL', symbol: string, quantity: number, price: number): Promise<void> {
    const account = this.accounts[0];
    const order: OrderRequest = {
      AccountID: account.AccountID,
      Symbol: symbol,
      Quantity: quantity.toString(),
      OrderType: 'Limit',
      TradeAction: side === 'BUY' ? 'BUY' : 'SELL',
      TimeInForce: {
        Duration: 'DAY'
      },
      LimitPrice: price.toString()
    };
    
    const response = await this.apiClient.placeOrder(order);
    if (response.success) {
      this.logger.info(`✅ Order placed: ${side} ${quantity} ${symbol} @ $${price.toFixed(2)}`);
    } else {
      this.logger.error(`❌ Order failed: ${response.error}`);
    }
  }

  private setupEventListeners(): void {
    // API Client Events
    this.apiClient.on('authenticated', () => {
      this.logger.info('🔐 API authenticated');
    });

    this.apiClient.on('authError', (error) => {
      this.logger.error('🔐❌ Authentication error:', error);
      this.emit('error', error);
    });

    // Streaming Events
    this.streamingClient.on('connected', () => {
      this.logger.info('🔌 Streaming connected');
    });

    this.streamingClient.on('disconnected', () => {
      this.logger.warn('🔌 Streaming disconnected');
    });

    this.streamingClient.on('error', (error) => {
      this.logger.error('Streaming error:', error);
      this.emit('error', error);
    });
  }

  // Status and monitoring methods
  async getDetailedStatus(): Promise<{
    status: string;
    uptime: string;
    accounts: number;
    totalTrades: number;
    dailyPnL: number;
    activePositions: any[];
    currentPosition: any;
    timestamp: string;
  }> {
    try {
      // Update positions from API
      if (this.accounts.length > 0) {
        await this.updatePositions();
      }

      const uptime = this.startTime 
        ? Math.floor((Date.now() - this.startTime.getTime()) / 1000 / 60) 
        : 0;

      return {
        status: this.isRunning ? 'running' : 'stopped',
        uptime: `${uptime} minutes`,
        accounts: this.accounts.length,
        totalTrades: this.totalTrades,
        dailyPnL: this.dailyPnL,
        activePositions: this.activePositions.map(p => ({
          symbol: p.Symbol,
          quantity: p.Quantity,
          side: 'LONG',
          marketValue: p.MarketValue,
          unrealizedPnL: p.UnrealizedProfitLoss
        })),
        currentPosition: this.currentPosition ? {
          symbol: this.currentPosition.symbol,
          entryPrice: this.currentPosition.entryPrice,
          currentPrice: this.currentPosition.currentPrice,
          unrealizedPnL: this.currentPosition.unrealizedPnL,
          entryTime: this.currentPosition.entryTime
        } : null,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('Error getting detailed status:', error);
      return {
        status: this.isRunning ? 'running' : 'stopped',
        uptime: '0 minutes',
        accounts: this.accounts.length,
        totalTrades: this.totalTrades,
        dailyPnL: this.dailyPnL,
        activePositions: [],
        currentPosition: null,
        timestamp: new Date().toISOString()
      };
    }
  }

  private async updatePositions(): Promise<void> {
    if (this.accounts.length === 0) return;

    try {
      const account = this.accounts[0];
      const response = await this.apiClient.getPositions([account.AccountID]);
      
      if (response.success && response.data) {
        this.activePositions = response.data;
        
        // Update daily P&L from positions
        const realizedPnL = 0; // TradeStation doesn't provide realized P&L in positions
        const unrealizedPnL = this.activePositions.reduce((sum, pos) => 
          sum + parseFloat(pos.UnrealizedProfitLoss || '0'), 0
        );
        this.dailyPnL = realizedPnL + unrealizedPnL;
      }
    } catch (error) {
      this.logger.error('Error updating positions:', error);
    }
  }

  // Getters
  getAccounts(): Account[] {
    return [...this.accounts];
  }

  getRunningStatus(): boolean {
    return this.isRunning;
  }

  getCurrentPosition(): ActivePosition | null {
    return this.currentPosition;
  }

  getDailyPnL(): number {
    return this.dailyPnL;
  }

  getTotalTrades(): number {
    return this.totalTrades;
  }
}