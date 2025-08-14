#!/usr/bin/env node

import 'dotenv/config';
import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { TradeStationClient } from './api/client';
import { TradeStationHttpStreaming } from './api/http-streaming';
import { createLogger } from './utils/logger';
import { BigQuery } from '@google-cloud/bigquery';
import {
  TradeStationConfig,
  Account,
  Position,
  Bar,
  Quote,
  OrderRequest,
  OrderResponse
} from './types/tradestation';

export interface StraddleBotConfig {
  tradeStation: TradeStationConfig & { streamingUrl?: string };
  strategy: {
    spxSymbol: string;
    entryTime: string; // "09:33" format
    targetProfitPercent: number; // e.g., 20 for 20%
    stopLossPercent?: number; // Optional, e.g., 50 for 50%
    exitTime: string; // "15:50" for 10 minutes before close
  };
  trading: {
    paperTrading: boolean;
    maxPositionValue: number; // Max dollar amount per straddle
    accountId?: string;
    contractMultiplier: number; // Usually 100 for options
  };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    file?: string;
  };
  bigquery?: {
    projectId: string;
    datasetId: string;
  };
}

interface StraddlePosition {
  entryTime: Date;
  spxPrice: number;
  strike: number;
  callSymbol: string;
  putSymbol: string;
  callEntryPrice: number;
  putEntryPrice: number;
  totalEntryPrice: number;
  quantity: number;
  targetPrice: number;
  stopPrice?: number;
  callOrderId?: string;
  putOrderId?: string;
  isOpen: boolean;
  exitReason?: 'TARGET' | 'STOP' | 'EOD';
  exitTime?: Date;
  callExitPrice?: number;
  putExitPrice?: number;
  totalExitPrice?: number;
  pnl?: number;
}

export class SPXStraddleBot extends EventEmitter {
  private config: StraddleBotConfig;
  private logger: Logger;
  private apiClient: TradeStationClient;
  private streamingClient: TradeStationHttpStreaming;
  private bigquery?: BigQuery;
  private accounts: Account[] = [];
  private isRunning = false;
  private startTime: Date | null = null;
  
  // Position tracking
  private currentStraddle: StraddlePosition | null = null;
  private dailyPnL = 0;
  private totalTrades = 0;
  private closedPositions: StraddlePosition[] = [];
  
  // Market data subscriptions
  private spxSubscriptionId: string | null = null;
  private callSubscriptionId: string | null = null;
  private putSubscriptionId: string | null = null;
  
  // Current market prices
  private currentSPXPrice = 0;
  private currentCallPrice = 0;
  private currentPutPrice = 0;
  
  // Bar consolidation for SPX price
  private lastBarTimestamp: string | null = null;
  
  // Timing
  private entryCheckInterval: NodeJS.Timeout | null = null;
  private positionMonitorInterval: NodeJS.Timeout | null = null;

  constructor(config: StraddleBotConfig) {
    super();
    this.config = config;
    this.logger = createLogger('SPXStraddleBot', config.logging);
    
    this.apiClient = new TradeStationClient(config.tradeStation);
    this.streamingClient = new TradeStationHttpStreaming(config.tradeStation);
    
    if (config.bigquery) {
      this.bigquery = new BigQuery({
        projectId: config.bigquery.projectId
      });
    }
    
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // API Client events
    this.apiClient.on('authenticated', () => {
      this.logger.info('API Client authenticated successfully');
    });

    this.apiClient.on('error', (error: Error) => {
      this.logger.error('API Client error:', error);
      this.emit('error', error);
    });

    // Streaming client events
    this.streamingClient.on('connected', () => {
      this.logger.info('Streaming client connected');
    });

    this.streamingClient.on('quote', (data: any) => {
      this.handleQuoteUpdate(data);
    });

    this.streamingClient.on('bar', (data: any) => {
      this.handleBarUpdate(data);
    });

    this.streamingClient.on('error', (error: Error) => {
      this.logger.error('Streaming error:', error);
      this.emit('error', error);
    });
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
    
    // Pass the authentication token to the streaming client
    const token = this.apiClient.getToken();
    if (token) {
      this.streamingClient.setAuthToken(token);
    }
    
    this.logger.info('✅ Authenticated with TradeStation');
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Bot is already running');
      return;
    }

    try {
      this.logger.info('Starting SPX Straddle Bot...');
      this.startTime = new Date();
      
      // Authenticate
      await this.authenticate();
      
      // Get accounts
      const response = await this.apiClient.getAccounts();
      if (!response.success || !response.data) {
        throw new Error('Failed to get accounts');
      }
      this.accounts = response.data;
      if (this.accounts.length === 0) {
        throw new Error('No accounts found');
      }
      
      const tradingAccount = this.config.trading.accountId 
        ? this.accounts.find(a => a.AccountID === this.config.trading.accountId)
        : this.accounts[0];
        
      if (!tradingAccount) {
        throw new Error(`Account ${this.config.trading.accountId} not found`);
      }
      
      this.logger.info(`Using account: ${tradingAccount.AccountID} (${tradingAccount.AccountType})`);
      
      // No need to explicitly connect streaming - it connects per subscription
      
      // Subscribe to SPX for price monitoring
      await this.subscribeToSPX();
      
      // Set up entry time checker
      this.setupEntryTimeChecker();
      
      // Set up position monitor (runs every 30 seconds)
      this.positionMonitorInterval = setInterval(() => {
        this.monitorPosition();
      }, 30000);
      
      this.isRunning = true;
      this.emit('started');
      
      this.logger.info('SPX Straddle Bot started successfully');
      this.logger.info(`Entry time: ${this.config.strategy.entryTime} ET`);
      this.logger.info(`Target profit: ${this.config.strategy.targetProfitPercent}%`);
      this.logger.info(`Stop loss: ${this.config.strategy.stopLossPercent ? this.config.strategy.stopLossPercent + '%' : 'None (hold to EOD)'}`);
      
    } catch (error) {
      this.logger.error('Failed to start bot:', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping SPX Straddle Bot...');
    
    // Clear intervals
    if (this.entryCheckInterval) {
      clearInterval(this.entryCheckInterval);
      this.entryCheckInterval = null;
    }
    
    if (this.positionMonitorInterval) {
      clearInterval(this.positionMonitorInterval);
      this.positionMonitorInterval = null;
    }
    
    // Close any open positions
    if (this.currentStraddle && this.currentStraddle.isOpen) {
      await this.closeStraddle('MANUAL_STOP');
    }
    
    // Unsubscribe from streams
    if (this.spxSubscriptionId) {
      await this.streamingClient.unsubscribe(this.spxSubscriptionId);
    }
    if (this.callSubscriptionId) {
      await this.streamingClient.unsubscribe(this.callSubscriptionId);
    }
    if (this.putSubscriptionId) {
      await this.streamingClient.unsubscribe(this.putSubscriptionId);
    }
    
    // Stop streaming happens automatically when subscriptions are cancelled
    
    this.isRunning = false;
    this.emit('stopped');
    
    // Log final summary
    this.logDailySummary();
  }

  private async subscribeToSPX(): Promise<void> {
    // Subscribe to 1-minute bars for proper price consolidation
    this.spxSubscriptionId = await this.streamingClient.subscribeToBars({
      symbol: this.config.strategy.spxSymbol,
      interval: 1,
      unit: 'Minute'
    });
    this.logger.info(`Subscribed to SPX 1-minute bars: ${this.config.strategy.spxSymbol}`);
  }

  private setupEntryTimeChecker(): void {
    // Check every minute if it's time to enter
    this.entryCheckInterval = setInterval(() => {
      this.checkEntryTime();
    }, 60000); // Every minute
    
    // Also check immediately
    this.checkEntryTime();
  }

  private checkEntryTime(): void {
    if (this.currentStraddle && this.currentStraddle.isOpen) {
      return; // Already have a position
    }
    
    const now = new Date();
    const [entryHour, entryMinute] = this.config.strategy.entryTime.split(':').map(Number);
    
    // Convert to ET
    const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const currentHour = etNow.getHours();
    const currentMinute = etNow.getMinutes();
    
    // Check if it's within 2 minutes of entry time
    if (currentHour === entryHour && Math.abs(currentMinute - entryMinute) <= 2) {
      this.logger.info(`Entry time reached at ${etNow.toLocaleTimeString('en-US', {timeZone: 'America/New_York'})}`);
      this.enterStraddle();
    }
  }

  private async enterStraddle(): Promise<void> {
    try {
      if (!this.currentSPXPrice || this.currentSPXPrice < 3000 || this.currentSPXPrice > 10000) {
        this.logger.error(`Invalid SPX price: ${this.currentSPXPrice}, skipping entry`);
        return;
      }
      
      this.logger.info(`Entering straddle with SPX at ${this.currentSPXPrice.toFixed(2)}`);
      
      // Calculate nearest strike (SPX strikes are in $5 increments)
      const strike = Math.round(this.currentSPXPrice / 5) * 5;
      
      // Get expiration date (0DTE for today)
      const expDate = new Date();
      const expDateStr = expDate.toISOString().split('T')[0].replace(/-/g, '');
      
      // Build option symbols (format: SPXW YYMMDD C/P STRIKE)
      const callSymbol = `SPXW ${expDateStr} C ${strike}`;
      const putSymbol = `SPXW ${expDateStr} P ${strike}`;
      
      this.logger.info(`Strike selected: ${strike}`);
      this.logger.info(`Call symbol: ${callSymbol}`);
      this.logger.info(`Put symbol: ${putSymbol}`);
      
      // Get option quotes
      const [callQuoteResponse, putQuoteResponse] = await Promise.all([
        this.apiClient.getQuote(callSymbol),
        this.apiClient.getQuote(putSymbol)
      ]);
      
      if (!callQuoteResponse.success || !putQuoteResponse.success) {
        this.logger.error('Failed to get option quotes');
        return;
      }
      
      const callQuote = callQuoteResponse.data;
      const putQuote = putQuoteResponse.data;
      const callPrice = Number(callQuote.Ask || callQuote.Last || 0);
      const putPrice = Number(putQuote.Ask || putQuote.Last || 0);
      const totalPrice = callPrice + putPrice;
      
      if (totalPrice <= 0) {
        this.logger.error('Invalid option prices, skipping entry');
        return;
      }
      
      // Calculate position size - Always 1 contract each (call + put = 1 straddle)
      const quantity = 1;
      const totalCost = totalPrice * this.config.trading.contractMultiplier; // Total cost for 1 straddle
      
      // Check if we have enough capital for 1 straddle
      if (totalCost > this.config.trading.maxPositionValue) {
        this.logger.error(`Straddle too expensive: $${totalCost.toFixed(2)} > Max $${this.config.trading.maxPositionValue}`);
        return;
      }
      
      // Calculate target and stop prices
      const targetPrice = totalPrice * (1 + this.config.strategy.targetProfitPercent / 100);
      const stopPrice = this.config.strategy.stopLossPercent 
        ? totalPrice * (1 - this.config.strategy.stopLossPercent / 100)
        : undefined;
      
      // Create position object
      this.currentStraddle = {
        entryTime: new Date(),
        spxPrice: this.currentSPXPrice,
        strike,
        callSymbol,
        putSymbol,
        callEntryPrice: callPrice,
        putEntryPrice: putPrice,
        totalEntryPrice: totalPrice,
        quantity,
        targetPrice,
        stopPrice,
        isOpen: true
      };
      
      this.logger.info(`Straddle position created:`);
      this.logger.info(`  Entry: $${totalPrice.toFixed(2)} (Call: $${callPrice.toFixed(2)}, Put: $${putPrice.toFixed(2)})`);
      this.logger.info(`  Quantity: ${quantity} contract each (1 straddle)`);
      this.logger.info(`  Total Cost: $${totalCost.toFixed(2)} (${totalPrice.toFixed(2)} × 100)`);
      this.logger.info(`  Target: $${targetPrice.toFixed(2)} (${this.config.strategy.targetProfitPercent}% profit)`);
      if (stopPrice) {
        this.logger.info(`  Stop: $${stopPrice.toFixed(2)} (${this.config.strategy.stopLossPercent}% loss)`);
      }
      
      // Place orders if not paper trading
      if (!this.config.trading.paperTrading) {
        await this.placeStraddleOrders();
      } else {
        this.logger.info('PAPER TRADE: Straddle entered (no real orders placed)');
      }
      
      // Subscribe to option quotes for monitoring
      await this.subscribeToOptions(callSymbol, putSymbol);
      
      this.totalTrades++;
      this.emit('straddleOpened', this.currentStraddle);
      
    } catch (error) {
      this.logger.error('Failed to enter straddle:', error);
      this.emit('error', error);
    }
  }

  private async placeStraddleOrders(): Promise<void> {
    if (!this.currentStraddle) return;
    
    try {
      const accountId = this.config.trading.accountId || this.accounts[0].AccountID;
      
      // Place call order
      const callOrder: OrderRequest = {
        AccountID: accountId,
        Symbol: this.currentStraddle.callSymbol,
        Quantity: this.currentStraddle.quantity.toString(),
        OrderType: 'Market',
        TradeAction: 'BUY',
        TimeInForce: { Duration: 'DAY' },
        Route: 'Intelligent'
      };
      
      // Place put order
      const putOrder: OrderRequest = {
        AccountID: accountId,
        Symbol: this.currentStraddle.putSymbol,
        Quantity: this.currentStraddle.quantity.toString(),
        OrderType: 'Market',
        TradeAction: 'BUY',
        TimeInForce: { Duration: 'DAY' },
        Route: 'Intelligent'
      };
      
      const [callResponse, putResponse] = await Promise.all([
        this.apiClient.placeOrder(callOrder),
        this.apiClient.placeOrder(putOrder)
      ]);
      
      if (callResponse.success && putResponse.success) {
        this.currentStraddle.callOrderId = callResponse.data.OrderID;
        this.currentStraddle.putOrderId = putResponse.data.OrderID;
        
        this.logger.info(`Orders placed - Call: ${callResponse.data.OrderID}, Put: ${putResponse.data.OrderID}`);
      } else {
        throw new Error('Failed to place orders');
      }
      
    } catch (error) {
      this.logger.error('Failed to place orders:', error);
      throw error;
    }
  }

  private async subscribeToOptions(callSymbol: string, putSymbol: string): Promise<void> {
    try {
      this.callSubscriptionId = await this.streamingClient.subscribeToQuotes(
        [callSymbol]
      );
      this.putSubscriptionId = await this.streamingClient.subscribeToQuotes(
        [putSymbol]
      );
      
      this.logger.info(`Subscribed to option quotes: ${callSymbol}, ${putSymbol}`);
    } catch (error) {
      this.logger.error('Failed to subscribe to options:', error);
    }
  }

  private handleQuoteUpdate(data: any): void {
    // Handle option quotes (tick data is OK for options)
    if (this.currentStraddle && data.quote) {
      const quote = data.quote;
      const symbol = data.symbol || quote.Symbol;
      
      if (symbol === this.currentStraddle.callSymbol) {
        this.currentCallPrice = Number(quote.Last || quote.Close || this.currentCallPrice);
        this.logger.debug(`Call price update: ${symbol} = $${this.currentCallPrice}`);
      } else if (symbol === this.currentStraddle.putSymbol) {
        this.currentPutPrice = Number(quote.Last || quote.Close || this.currentPutPrice);
        this.logger.debug(`Put price update: ${symbol} = $${this.currentPutPrice}`);
      }
    }
  }

  private handleBarUpdate(data: any): void {
    // Handle SPX bar updates - this gives us proper 1-minute consolidated prices
    if (data.bar && data.symbol === this.config.strategy.spxSymbol) {
      const bar = data.bar;
      const timestamp = bar.TimeStamp || bar.Timestamp;
      
      // Only update if this is a new bar (avoid duplicate ticks)
      if (!this.lastBarTimestamp || timestamp !== this.lastBarTimestamp) {
        this.currentSPXPrice = Number(bar.Close);
        this.lastBarTimestamp = timestamp;
        
        this.logger.debug(`📊 SPX Bar: ${timestamp} = $${this.currentSPXPrice.toFixed(2)} (O:${bar.Open} H:${bar.High} L:${bar.Low})`);
        
        // Log significant price moves
        const priceChange = Math.abs(this.currentSPXPrice - Number(bar.Open));
        if (priceChange > 5) {
          this.logger.info(`📊 Significant SPX move: $${priceChange.toFixed(2)} in 1 minute to $${this.currentSPXPrice.toFixed(2)}`);
        }
      }
    }
  }

  private async monitorPosition(): Promise<void> {
    if (!this.currentStraddle || !this.currentStraddle.isOpen) {
      return;
    }
    
    const totalCurrentPrice = this.currentCallPrice + this.currentPutPrice;
    
    if (totalCurrentPrice <= 0) {
      return; // No valid prices yet
    }
    
    const pnl = (totalCurrentPrice - this.currentStraddle.totalEntryPrice) * this.currentStraddle.quantity * this.config.trading.contractMultiplier;
    const pnlPercent = ((totalCurrentPrice - this.currentStraddle.totalEntryPrice) / this.currentStraddle.totalEntryPrice) * 100;
    
    this.logger.debug(`Position monitor - Current: $${totalCurrentPrice.toFixed(2)}, P&L: $${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}%)`);
    
    // Check exit conditions
    // 1. Target profit hit
    if (totalCurrentPrice >= this.currentStraddle.targetPrice) {
      this.logger.info(`TARGET HIT at ${totalCurrentPrice.toFixed(2)} (${pnlPercent.toFixed(1)}% profit)`);
      await this.closeStraddle('TARGET');
    }
    // 2. Stop loss hit
    else if (this.currentStraddle.stopPrice && totalCurrentPrice <= this.currentStraddle.stopPrice) {
      this.logger.info(`STOP LOSS HIT at ${totalCurrentPrice.toFixed(2)} (${pnlPercent.toFixed(1)}% loss)`);
      await this.closeStraddle('STOP');
    }
    // 3. End of day exit
    else {
      const now = new Date();
      const [exitHour, exitMinute] = this.config.strategy.exitTime.split(':').map(Number);
      const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
      
      if (etNow.getHours() >= exitHour && etNow.getMinutes() >= exitMinute) {
        this.logger.info(`END OF DAY EXIT at ${totalCurrentPrice.toFixed(2)} (${pnlPercent.toFixed(1)}%)`);
        await this.closeStraddle('EOD');
      }
    }
  }

  private async closeStraddle(reason: 'TARGET' | 'STOP' | 'EOD' | 'MANUAL_STOP'): Promise<void> {
    if (!this.currentStraddle || !this.currentStraddle.isOpen) {
      return;
    }
    
    try {
      this.currentStraddle.exitTime = new Date();
      this.currentStraddle.exitReason = reason === 'MANUAL_STOP' ? 'EOD' : reason;
      this.currentStraddle.callExitPrice = this.currentCallPrice;
      this.currentStraddle.putExitPrice = this.currentPutPrice;
      this.currentStraddle.totalExitPrice = this.currentCallPrice + this.currentPutPrice;
      this.currentStraddle.pnl = (this.currentStraddle.totalExitPrice - this.currentStraddle.totalEntryPrice) * 
                                  this.currentStraddle.quantity * this.config.trading.contractMultiplier;
      this.currentStraddle.isOpen = false;
      
      // Place closing orders if not paper trading
      if (!this.config.trading.paperTrading) {
        await this.placeClosingOrders();
      }
      
      // Update daily P&L
      this.dailyPnL += this.currentStraddle.pnl;
      
      // Log the trade
      this.logger.info(`Straddle closed - Reason: ${reason}`);
      this.logger.info(`  Entry: $${this.currentStraddle.totalEntryPrice.toFixed(2)}`);
      this.logger.info(`  Exit: $${this.currentStraddle.totalExitPrice.toFixed(2)}`);
      this.logger.info(`  P&L: $${this.currentStraddle.pnl.toFixed(2)} (${((this.currentStraddle.pnl / (this.currentStraddle.totalEntryPrice * this.currentStraddle.quantity * this.config.trading.contractMultiplier)) * 100).toFixed(1)}%)`);
      
      // Store closed position
      this.closedPositions.push(this.currentStraddle);
      
      // Emit event
      this.emit('straddleClosed', this.currentStraddle);
      
      // Save to BigQuery if configured
      if (this.bigquery) {
        await this.saveTradeToDatabase(this.currentStraddle);
      }
      
      // Clear current position
      this.currentStraddle = null;
      
      // Unsubscribe from options
      if (this.callSubscriptionId) {
        await this.streamingClient.unsubscribe(this.callSubscriptionId);
        this.callSubscriptionId = null;
      }
      if (this.putSubscriptionId) {
        await this.streamingClient.unsubscribe(this.putSubscriptionId);
        this.putSubscriptionId = null;
      }
      
    } catch (error) {
      this.logger.error('Failed to close straddle:', error);
      this.emit('error', error);
    }
  }

  private async placeClosingOrders(): Promise<void> {
    if (!this.currentStraddle) return;
    
    try {
      const accountId = this.config.trading.accountId || this.accounts[0].AccountID;
      
      // Place call closing order
      const callOrder: OrderRequest = {
        AccountID: accountId,
        Symbol: this.currentStraddle.callSymbol,
        Quantity: this.currentStraddle.quantity.toString(),
        OrderType: 'Market',
        TradeAction: 'SELL',
        TimeInForce: { Duration: 'DAY' },
        Route: 'Intelligent'
      };
      
      // Place put closing order
      const putOrder: OrderRequest = {
        AccountID: accountId,
        Symbol: this.currentStraddle.putSymbol,
        Quantity: this.currentStraddle.quantity.toString(),
        OrderType: 'Market',
        TradeAction: 'SELL',
        TimeInForce: { Duration: 'DAY' },
        Route: 'Intelligent'
      };
      
      const [callResponse, putResponse] = await Promise.all([
        this.apiClient.placeOrder(callOrder),
        this.apiClient.placeOrder(putOrder)
      ]);
      
      if (callResponse.success && putResponse.success) {
        this.logger.info(`Closing orders placed - Call: ${callResponse.data.OrderID}, Put: ${putResponse.data.OrderID}`);
      } else {
        this.logger.error('Failed to place closing orders');
      }
      
    } catch (error) {
      this.logger.error('Failed to place closing orders:', error);
      throw error;
    }
  }

  private async saveTradeToDatabase(position: StraddlePosition): Promise<void> {
    if (!this.bigquery || !this.config.bigquery) return;
    
    try {
      const dataset = this.bigquery.dataset(this.config.bigquery.datasetId);
      const table = dataset.table('straddle_trades');
      
      const row = {
        trade_date: position.entryTime.toISOString().split('T')[0],
        entry_time: position.entryTime.toISOString(),
        exit_time: position.exitTime?.toISOString(),
        spx_price: position.spxPrice,
        strike: position.strike,
        call_entry: position.callEntryPrice,
        put_entry: position.putEntryPrice,
        total_entry: position.totalEntryPrice,
        call_exit: position.callExitPrice,
        put_exit: position.putExitPrice,
        total_exit: position.totalExitPrice,
        quantity: position.quantity,
        exit_reason: position.exitReason,
        pnl: position.pnl,
        pnl_percent: position.pnl ? (position.pnl / (position.totalEntryPrice * position.quantity * this.config.trading.contractMultiplier)) * 100 : 0
      };
      
      await table.insert([row]);
      this.logger.info('Trade saved to BigQuery');
      
    } catch (error) {
      this.logger.error('Failed to save trade to database:', error);
    }
  }

  private logDailySummary(): void {
    const wins = this.closedPositions.filter(p => (p.pnl || 0) > 0);
    const losses = this.closedPositions.filter(p => (p.pnl || 0) <= 0);
    const winRate = this.closedPositions.length > 0 ? (wins.length / this.closedPositions.length) * 100 : 0;
    
    this.logger.info('=== DAILY SUMMARY ===');
    this.logger.info(`Total Trades: ${this.totalTrades}`);
    this.logger.info(`Wins: ${wins.length} | Losses: ${losses.length}`);
    this.logger.info(`Win Rate: ${winRate.toFixed(1)}%`);
    this.logger.info(`Daily P&L: $${this.dailyPnL.toFixed(2)}`);
    
    if (wins.length > 0) {
      const avgWin = wins.reduce((sum, p) => sum + (p.pnl || 0), 0) / wins.length;
      this.logger.info(`Average Win: $${avgWin.toFixed(2)}`);
    }
    
    if (losses.length > 0) {
      const avgLoss = losses.reduce((sum, p) => sum + (p.pnl || 0), 0) / losses.length;
      this.logger.info(`Average Loss: $${avgLoss.toFixed(2)}`);
    }
    
    this.logger.info('====================');
  }

  public async getDetailedStatus(): Promise<any> {
    const uptime = this.startTime 
      ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
      : 0;
      
    const formatUptime = (seconds: number): string => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };
    
    return {
      status: this.isRunning ? 'running' : 'stopped',
      timestamp: new Date().toISOString(),
      uptime: formatUptime(uptime),
      accounts: this.accounts.map(a => a.AccountID),
      totalTrades: this.totalTrades,
      dailyPnL: this.dailyPnL,
      currentPosition: this.currentStraddle ? {
        symbol: `${this.currentStraddle.strike} Straddle`,
        entryPrice: this.currentStraddle.totalEntryPrice,
        currentPrice: this.currentCallPrice + this.currentPutPrice,
        entryTime: this.currentStraddle.entryTime.toISOString(),
        unrealizedPnL: ((this.currentCallPrice + this.currentPutPrice) - this.currentStraddle.totalEntryPrice) * 
                       this.currentStraddle.quantity * this.config.trading.contractMultiplier,
        targetPrice: this.currentStraddle.targetPrice,
        stopPrice: this.currentStraddle.stopPrice
      } : null,
      closedPositions: this.closedPositions.length,
      activePositions: this.currentStraddle && this.currentStraddle.isOpen ? [{
        symbol: `SPX ${this.currentStraddle.strike} Straddle`,
        quantity: this.currentStraddle.quantity,
        side: 'LONG',
        unrealizedPnL: ((this.currentCallPrice + this.currentPutPrice) - this.currentStraddle.totalEntryPrice) * 
                       this.currentStraddle.quantity * this.config.trading.contractMultiplier
      }] : [],
      config: {
        entryTime: this.config.strategy.entryTime,
        targetProfit: this.config.strategy.targetProfitPercent,
        stopLoss: this.config.strategy.stopLossPercent,
        paperTrading: this.config.trading.paperTrading
      }
    };
  }
}