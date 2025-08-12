// Simple Trading Bot - SPX Strategy with HTTP Streaming
// Uses proven SPX backtest logic with real-time TradeStation data

import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { TradeStationClient } from './api/client';
import { TradeStationHttpStreaming } from './api/http-streaming';
import { createLogger } from './utils/logger';
import {
  TradeStationConfig,
  Account,
  Bar,
  Quote
} from './types/tradestation';

interface SimpleTradingBotConfig {
  tradeStation: TradeStationConfig;
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

interface Position {
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

export class SimpleTradingBot extends EventEmitter {
  private config: SimpleTradingBotConfig;
  private logger: Logger;
  private apiClient: TradeStationClient;
  private streamingClient: TradeStationHttpStreaming;
  private accounts: Account[] = [];
  private isRunning = false;
  
  // Strategy state
  private currentPosition: Position | null = null;
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

  constructor(config: SimpleTradingBotConfig) {
    super();
    this.config = config;
    this.logger = createLogger('SimpleTradingBot', config.logging);
    
    this.apiClient = new TradeStationClient(config.tradeStation);
    this.streamingClient = new TradeStationHttpStreaming(config.tradeStation);
    
    this.setupEventListeners();
  }

  async start(): Promise<void> {
    try {
      this.logger.info('🚀 Starting Simple Trading Bot...');
      
      await this.authenticate();
      await this.loadAccounts();
      await this.startSpxStreaming();
      
      this.isRunning = true;
      this.logger.info('✅ Simple Trading Bot started successfully');
      this.emit('started');
      
    } catch (error) {
      this.logger.error('❌ Failed to start Simple Trading Bot:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      this.logger.info('🛑 Stopping Simple Trading Bot...');
      
      this.streamingClient.unsubscribeAll();
      this.streamingClient.destroy();
      this.apiClient.destroy();
      
      this.isRunning = false;
      this.logger.info('✅ Simple Trading Bot stopped');
      this.emit('stopped');
      
    } catch (error) {
      this.logger.error('❌ Error stopping Simple Trading Bot:', error);
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

    const token = this.apiClient.getToken();
    if (token) {
      this.streamingClient.setAuthToken(token);
    }

    this.logger.info('✅ Authentication successful');
  }

  private async loadAccounts(): Promise<void> {
    const response = await this.apiClient.getAccounts();
    if (!response.success || !response.data) {
      throw new Error('Failed to load accounts');
    }

    this.accounts = response.data;
    this.logger.info(`✅ Loaded ${this.accounts.length} accounts`);
    
    // Set default account if not configured
    if (!this.config.trading.accountId && this.accounts.length > 0) {
      this.config.trading.accountId = this.accounts[0].AccountID;
      this.logger.info(`Using default account: ${this.accounts[0].AccountID}`);
    }
  }

  private async startSpxStreaming(): Promise<void> {
    this.logger.info(`📊 Starting SPX streaming: ${this.config.strategy.spxSymbol}`);
    
    this.spxSubscriptionId = await this.streamingClient.subscribeToBars({
      symbol: this.config.strategy.spxSymbol,
      interval: 1,
      unit: 'Minute'
    });
    
    this.logger.info(`✅ SPX streaming started: ${this.spxSubscriptionId}`);
  }

  private async startOptionStreaming(optionSymbol: string): Promise<void> {
    if (this.optionSubscriptionId) {
      this.streamingClient.unsubscribe(this.optionSubscriptionId);
    }
    
    this.logger.info(`📈 Starting option streaming: ${optionSymbol}`);
    
    this.optionSubscriptionId = await this.streamingClient.subscribeToQuotes([optionSymbol]);
    
    this.logger.info(`✅ Option streaming started: ${this.optionSubscriptionId}`);
  }

  private calculateEMA(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1] || 0;
    
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    
    for (let i = period; i < values.length; i++) {
      ema = (values[i] * multiplier) + (ema * (1 - multiplier));
    }
    
    return ema;
  }

  private calculateMACD(bar: Bar): MACDValues | null {
    // Add close price to history
    const closePrices = this.spxBars.map(b => parseFloat(b.Close));
    
    if (closePrices.length < this.config.strategy.macdSlowPeriod) {
      return null;
    }

    // Calculate EMAs
    const ema12 = this.calculateEMA(closePrices, this.config.strategy.macdFastPeriod);
    const ema26 = this.calculateEMA(closePrices, this.config.strategy.macdSlowPeriod);
    
    // MACD line = EMA12 - EMA26
    const macd = ema12 - ema26;
    this.macdLine.push(macd);
    
    // Keep only recent MACD values
    if (this.macdLine.length > 50) {
      this.macdLine.shift();
    }
    
    // Signal line = EMA of MACD line
    const signal = this.calculateEMA(this.macdLine, this.config.strategy.macdSignalPeriod);
    
    // Histogram = MACD - Signal
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
    
    // Update previous values
    this.previousMacd = macd;
    this.previousSignal = signal;
    
    // Update histogram history
    this.histogramHistory.push(histogram);
    if (this.histogramHistory.length > 4) {
      this.histogramHistory.shift();
    }
    
    return { macd, signal, histogram, crossover };
  }

  private isHistogramIncreasing(): boolean {
    if (this.histogramHistory.length < 4) return false;
    
    for (let i = 1; i < this.histogramHistory.length; i++) {
      if (this.histogramHistory[i] <= this.histogramHistory[i - 1]) {
        return false;
      }
    }
    
    return true;
  }

  private isWithinTradingHours(timestamp: string): boolean {
    const date = new Date(timestamp);
    const etTime = new Date(date.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const hours = etTime.getHours();
    const minutes = etTime.getMinutes();
    
    // Market hours: 9:30 AM - 3:30 PM ET (no new positions after 3:30)
    if (hours < 9 || (hours === 9 && minutes < 30)) return false;
    if (hours > 15 || (hours === 15 && minutes >= 30)) return false;
    
    return true;
  }

  private constructOptionSymbol(spxPrice: number, timestamp: string): string {
    const date = new Date(timestamp);
    const strike = Math.floor(spxPrice / 5) * 5;
    
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `SPXW ${year}${month}${day}C${strike}`;
  }

  private async executeOrder(symbol: string, action: 'BUY' | 'SELL', quantity: number, price?: number): Promise<boolean> {
    if (this.config.trading.paperTrading) {
      this.logger.info(`📄 PAPER TRADE: ${action} ${quantity} ${symbol} ${price ? `@ $${price}` : '@ MARKET'}`);
      
      // Simulate order fill for paper trading
      setTimeout(() => {
        const fillPrice = price || (action === 'BUY' ? 10.0 : 8.0); // Mock prices
        this.handleOrderFill(symbol, action, quantity, fillPrice);
      }, 1000);
      
      return true;
    }
    
    // Real trading implementation would go here
    this.logger.warn('Real trading not implemented - use paperTrading: true');
    return false;
  }

  private handleOrderFill(symbol: string, action: 'BUY' | 'SELL', quantity: number, fillPrice: number): void {
    if (action === 'BUY' && symbol.startsWith('SPXW')) {
      const spxPrice = this.spxBars.length > 0 ? parseFloat(this.spxBars[this.spxBars.length - 1].Close) : 0;
      
      this.currentPosition = {
        symbol,
        entryPrice: fillPrice,
        entryTime: new Date(),
        quantity,
        spxPriceAtEntry: spxPrice
      };
      
      this.logger.info(`✅ POSITION OPENED: ${symbol} at $${fillPrice}, SPX @ ${spxPrice}`);
      this.emit('positionOpened', this.currentPosition);
      
      // Start streaming the option for P&L tracking
      this.startOptionStreaming(symbol);
      
    } else if (action === 'SELL' && this.currentPosition?.symbol === symbol) {
      const profit = (fillPrice - this.currentPosition.entryPrice) * quantity * 100;
      const holdTime = Math.floor((new Date().getTime() - this.currentPosition.entryTime.getTime()) / 60000);
      
      this.logger.info(`✅ POSITION CLOSED: ${symbol} at $${fillPrice}, P&L: $${profit.toFixed(2)}, Hold: ${holdTime}min`);
      this.emit('positionClosed', {
        position: this.currentPosition,
        exitPrice: fillPrice,
        profit,
        holdTime
      });
      
      this.currentPosition = null;
      
      // Stop option streaming
      if (this.optionSubscriptionId) {
        this.streamingClient.unsubscribe(this.optionSubscriptionId);
        this.optionSubscriptionId = null;
      }
    }
  }

  private async processSpxBar(bar: Bar): Promise<void> {
    // Add to history
    this.spxBars.push(bar);
    if (this.spxBars.length > 200) {
      this.spxBars.shift();
    }
    
    // Calculate MACD
    const macdValues = this.calculateMACD(bar);
    if (!macdValues) return;
    
    const spxPrice = parseFloat(bar.Close);
    
    // Entry logic
    if (!this.currentPosition && 
        macdValues.macd <= this.config.strategy.macdThreshold &&
        macdValues.crossover === 'bullish' &&
        this.isHistogramIncreasing() &&
        this.isWithinTradingHours(bar.TimeStamp)) {
      
      const optionSymbol = this.constructOptionSymbol(spxPrice, bar.TimeStamp);
      
      this.logger.info(`🎯 ENTRY SIGNAL: MACD=${macdValues.macd.toFixed(3)}, Crossover=bullish, Histogram increasing`);
      this.logger.info(`🎯 Target Option: ${optionSymbol}`);
      
      await this.executeOrder(optionSymbol, 'BUY', 1);
    }
    
    // Exit logic
    if (this.currentPosition) {
      const profit = this.currentPosition.unrealizedPnL || 0;
      const profitTargetReached = profit >= this.config.strategy.profitTarget;
      const stopLossHit = profit <= -(this.currentPosition.entryPrice * this.config.strategy.stopLossPercentage);
      const bearishCrossover = macdValues.crossover === 'bearish';
      
      let exitReason = '';
      if (profitTargetReached && macdValues.histogram < (this.histogramHistory[this.histogramHistory.length - 2] || 0)) {
        exitReason = 'Profit target + momentum decline';
      } else if (stopLossHit) {
        exitReason = 'Stop loss';
      } else if (bearishCrossover) {
        exitReason = 'Bearish crossover';
      }
      
      if (exitReason) {
        this.logger.info(`🎯 EXIT SIGNAL: ${exitReason}`);
        await this.executeOrder(this.currentPosition.symbol, 'SELL', this.currentPosition.quantity);
      }
    }
    
    // Log status
    this.logger.debug(`📊 SPX: $${spxPrice} | MACD: ${macdValues.macd.toFixed(3)} | Signal: ${macdValues.signal.toFixed(3)} | Hist: ${macdValues.histogram.toFixed(3)} | Cross: ${macdValues.crossover}`);
  }

  private updatePositionPnL(quote: Quote): void {
    if (this.currentPosition && quote.Symbol === this.currentPosition.symbol) {
      const currentPrice = parseFloat(quote.Last);
      this.currentPosition.currentPrice = currentPrice;
      this.currentPosition.unrealizedPnL = (currentPrice - this.currentPosition.entryPrice) * this.currentPosition.quantity * 100;
      
      this.logger.debug(`💰 P&L Update: ${this.currentPosition.symbol} = $${currentPrice} (${this.currentPosition.unrealizedPnL >= 0 ? '+' : ''}${this.currentPosition.unrealizedPnL.toFixed(2)})`);
    }
  }

  private setupEventListeners(): void {
    // Streaming Events
    this.streamingClient.on('bar', (data) => {
      if (data.symbol === this.config.strategy.spxSymbol) {
        this.processSpxBar(data.bar);
      }
    });

    this.streamingClient.on('quote', (data) => {
      if (this.currentPosition && data.symbol === this.currentPosition.symbol) {
        this.updatePositionPnL(data.quote);
      }
    });

    this.streamingClient.on('error', (error) => {
      this.logger.error('📡❌ Streaming error:', error);
      this.emit('error', error);
    });
  }

  // Public methods for monitoring
  getStatus(): any {
    return {
      isRunning: this.isRunning,
      currentPosition: this.currentPosition,
      spxBarsCount: this.spxBars.length,
      macdHistoryLength: this.histogramHistory.length,
      subscriptions: {
        spx: this.spxSubscriptionId,
        option: this.optionSubscriptionId
      }
    };
  }

  getAccounts(): Account[] {
    return [...this.accounts];
  }
}