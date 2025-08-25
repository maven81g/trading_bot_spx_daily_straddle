#!/usr/bin/env node

import 'dotenv/config';
import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { TradeStationClient } from './api/client';
import { TradeStationHttpStreaming } from './api/http-streaming';
import { createLogger } from './utils/logger';
import { HeartbeatMonitor } from './utils/heartbeat-monitor';
import { BigQuery } from '@google-cloud/bigquery';
import {
  TradeStationConfig,
  Account,
  Position,
  Bar,
  Quote,
  Order,
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
  heartbeat?: {
    enabled: boolean;
    intervalMs?: number;
    webhookUrl?: string;
    logPath?: string;
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
  private heartbeatMonitor?: HeartbeatMonitor;
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
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastDataReceived: Date = new Date();

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
    
    // Setup heartbeat monitor if configured
    if (config.heartbeat?.enabled) {
      this.heartbeatMonitor = new HeartbeatMonitor({
        intervalMs: config.heartbeat.intervalMs || 60000, // Default 1 minute
        webhookUrl: config.heartbeat.webhookUrl,
        fileLogPath: config.heartbeat.logPath || './logs/heartbeat.log',
        alertAfterMissedBeats: 3
      }, this.logger);
      
      this.heartbeatMonitor.on('alert', (message: string) => {
        this.logger.error(`Heartbeat Alert: ${message}`);
        this.emit('heartbeatAlert', message);
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
      
      // Set up data stream heartbeat monitor (runs every 60 seconds)
      this.logger.info('Setting up data stream monitor (60s intervals)');
      this.heartbeatInterval = setInterval(() => {
        this.checkHeartbeat();
      }, 60000);
      
      // Run initial heartbeat check after 10 seconds
      setTimeout(() => {
        this.logger.info('Running initial data stream check...');
        this.checkHeartbeat();
      }, 10000);
      
      // Start the system heartbeat monitor if configured
      if (this.heartbeatMonitor) {
        this.heartbeatMonitor.start(async () => {
          // Provide bot status for heartbeat
          return {
            isRunning: this.isRunning,
            spxPrice: this.currentSPXPrice,
            hasPosition: this.currentStraddle?.isOpen || false,
            dailyPnL: this.dailyPnL,
            totalTrades: this.totalTrades,
            lastDataReceived: this.lastDataReceived.toISOString(),
            dataStreamStatus: this.getDataStreamStatus()
          };
        });
        this.logger.info('System heartbeat monitor started');
      }
      
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
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Stop heartbeat monitor
    if (this.heartbeatMonitor) {
      this.heartbeatMonitor.stop();
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
    // Check every 30 seconds for better accuracy
    this.entryCheckInterval = setInterval(() => {
      this.checkEntryTime();
    }, 30000); // Every 30 seconds
    
    // Wait a bit for SPX price to arrive, then check
    setTimeout(() => {
      this.checkEntryTime();
    }, 5000); // Check after 5 seconds (enough time for first SPX bar)
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
    
    // Log current check status
    this.logger.debug(`Entry check: ${currentHour}:${String(currentMinute).padStart(2, '0')} ET | Target: ${entryHour}:${String(entryMinute).padStart(2, '0')} | SPX: $${this.currentSPXPrice.toFixed(2)}`);
    
    // Check if it's within 2 minutes of entry time
    if (currentHour === entryHour && Math.abs(currentMinute - entryMinute) <= 2) {
      this.logger.info(`🎯 Entry time reached at ${etNow.toLocaleTimeString('en-US', {timeZone: 'America/New_York'})}`);
      
      // Make sure we have SPX price
      if (!this.currentSPXPrice || this.currentSPXPrice === 0) {
        this.logger.warn(`⚠️ Entry time reached but no SPX price yet. Waiting for price data...`);
        return;
      }
      
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
      const year = expDate.getFullYear().toString().slice(-2); // Get last 2 digits of year
      const month = (expDate.getMonth() + 1).toString().padStart(2, '0');
      const day = expDate.getDate().toString().padStart(2, '0');
      const expDateStr = `${year}${month}${day}`; // Format: YYMMDD
      
      // Build option symbols (format: SPXW YYMMDDCSTRIKE, e.g., SPXW 250814C6440)
      const callSymbol = `SPXW ${expDateStr}C${strike}`;
      const putSymbol = `SPXW ${expDateStr}P${strike}`;
      
      this.logger.info(`Strike selected: ${strike}`);
      this.logger.info(`Call symbol: ${callSymbol}`);
      this.logger.info(`Put symbol: ${putSymbol}`);
      
      // Get option quotes
      const [callQuoteResponse, putQuoteResponse] = await Promise.all([
        this.apiClient.getQuote(callSymbol),
        this.apiClient.getQuote(putSymbol)
      ]);
      
      // Log the raw responses for debugging
      this.logger.debug(`Call quote response:`, callQuoteResponse);
      this.logger.debug(`Put quote response:`, putQuoteResponse);
      
      if (!callQuoteResponse.success || !putQuoteResponse.success) {
        this.logger.error('Failed to get option quotes');
        this.logger.error(`Call response success: ${callQuoteResponse.success}, data: ${JSON.stringify(callQuoteResponse.data)}`);
        this.logger.error(`Put response success: ${putQuoteResponse.success}, data: ${JSON.stringify(putQuoteResponse.data)}`);
        return;
      }
      
      const callQuote = callQuoteResponse.data;
      const putQuote = putQuoteResponse.data;
      
      // Log the quote details
      this.logger.info(`Call quote - Symbol: ${callSymbol}, Bid: ${callQuote.Bid}, Ask: ${callQuote.Ask}, Last: ${callQuote.Last}`);
      this.logger.info(`Put quote - Symbol: ${putSymbol}, Bid: ${putQuote.Bid}, Ask: ${putQuote.Ask}, Last: ${putQuote.Last}`);
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
        this.logger.info('PAPER TRADE: Straddle entered (no real orders placed)');
      } else {
        // For paper trading, emit success immediately
        this.totalTrades++;
        this.emit('straddleOpened', this.currentStraddle);
      }
      
      // Subscribe to option quotes for monitoring
      await this.subscribeToOptions(callSymbol, putSymbol);
      
    } catch (error) {
      this.logger.error('Failed to enter straddle:', error);
      // Clear position if straddle creation failed
      this.currentStraddle = null;
      this.emit('error', error);
    }
  }

  private async placeStraddleOrders(): Promise<void> {
    if (!this.currentStraddle) return;
    
    let callOrderId: string | null = null;
    let putOrderId: string | null = null;
    
    try {
      const accountId = this.config.trading.accountId || this.accounts[0].AccountID;
      
      // Place call order
      const callOrder: OrderRequest = {
        AccountID: accountId,
        Symbol: this.currentStraddle.callSymbol,
        Quantity: this.currentStraddle.quantity.toString(),
        OrderType: 'Market',
        TradeAction: 'BUYTOOPEN',
        TimeInForce: { Duration: 'DAY' },
        Route: 'Intelligent'
      };
      
      // Place put order
      const putOrder: OrderRequest = {
        AccountID: accountId,
        Symbol: this.currentStraddle.putSymbol,
        Quantity: this.currentStraddle.quantity.toString(),
        OrderType: 'Market',
        TradeAction: 'BUYTOOPEN',
        TimeInForce: { Duration: 'DAY' },
        Route: 'Intelligent'
      };
      
      const [callResponse, putResponse] = await Promise.all([
        this.apiClient.placeOrder(callOrder),
        this.apiClient.placeOrder(putOrder)
      ]);
      
      // Track successful orders for potential rollback
      if (callResponse.success) {
        callOrderId = callResponse.data.OrderID;
        this.logger.info(`Call order placed: ${callOrderId}`);
      }
      if (putResponse.success) {
        putOrderId = putResponse.data.OrderID;
        this.logger.info(`Put order placed: ${putOrderId}`);
      }
      
      // Both orders must succeed
      if (callResponse.success && putResponse.success) {
        this.currentStraddle.callOrderId = callOrderId!;
        this.currentStraddle.putOrderId = putOrderId!;
        
        this.logger.info(`✅ Both orders successful - Call: ${callOrderId}, Put: ${putOrderId}`);
        
        // Only now emit success and increment trade count
        this.totalTrades++;
        this.emit('straddleOpened', this.currentStraddle);
        
      } else {
        // Rollback: Cancel or close any successful order
        if (callOrderId) {
          this.logger.warn(`❌ Put order failed, handling successful call order: ${callOrderId}`);
          await this.cancelOrCloseOrder(callOrderId, this.currentStraddle.callSymbol, this.currentStraddle.quantity);
        }
        if (putOrderId) {
          this.logger.warn(`❌ Call order failed, handling successful put order: ${putOrderId}`);
          await this.cancelOrCloseOrder(putOrderId, this.currentStraddle.putSymbol, this.currentStraddle.quantity);
        }
        
        // Clear the position since orders failed
        this.currentStraddle = null;
        
        throw new Error(`Orders failed - Call: ${callResponse.success ? 'OK' : 'FAILED'}, Put: ${putResponse.success ? 'OK' : 'FAILED'}`);
      }
      
    } catch (error) {
      this.logger.error('Failed to place straddle orders:', error);
      
      // Rollback any successful orders on exception
      if (callOrderId && this.currentStraddle) {
        this.logger.warn(`Exception occurred, handling call order: ${callOrderId}`);
        try { await this.cancelOrCloseOrder(callOrderId, this.currentStraddle.callSymbol, this.currentStraddle.quantity); } catch (e) { this.logger.error('Failed to handle call order:', e); }
      }
      if (putOrderId && this.currentStraddle) {
        this.logger.warn(`Exception occurred, handling put order: ${putOrderId}`);
        try { await this.cancelOrCloseOrder(putOrderId, this.currentStraddle.putSymbol, this.currentStraddle.quantity); } catch (e) { this.logger.error('Failed to handle put order:', e); }
      }
      
      // Clear the position since orders failed
      this.currentStraddle = null;
      throw error;
    }
  }

  private async cancelOrCloseOrder(orderId: string, symbol: string, quantity: number): Promise<void> {
    try {
      // First, try to cancel the order (in case it's still pending)
      this.logger.info(`🔄 Attempting to cancel order: ${orderId}`);
      const cancelResponse = await this.apiClient.cancelOrder(orderId);
      
      if (cancelResponse.success) {
        this.logger.info(`✅ Order cancelled: ${orderId}`);
        return;
      }
      
      // If cancel failed, check if order was already filled
      this.logger.warn(`❌ Cancel failed for ${orderId}: ${cancelResponse.error}`);
      this.logger.info(`🔍 Checking order status to determine if filled...`);
      
      // Get order status
      const accountId = this.config.trading.accountId || this.accounts[0]?.AccountID;
      if (!accountId) {
        throw new Error('No account ID available for order status check');
      }
      
      const ordersResponse = await this.apiClient.getOrders(accountId);
      if (!ordersResponse.success) {
        throw new Error(`Failed to get orders: ${ordersResponse.error}`);
      }
      
      const order = ordersResponse.data.find(o => o.OrderID === orderId);
      if (!order) {
        this.logger.warn(`⚠️ Order ${orderId} not found in account orders - may have been cancelled or expired`);
        return;
      }
      
      this.logger.info(`📋 Order ${orderId} status: ${order.Status} (${order.StatusDescription})`);
      
      // Check if order was filled/executed
      const filledStatuses = ['Filled', 'Partially Filled', 'Executed'];
      if (filledStatuses.some(status => order.Status.includes(status))) {
        this.logger.warn(`⚠️ Order ${orderId} already filled - placing sell order to close position`);
        
        // Place sell order to close the filled position
        const sellOrder: OrderRequest = {
          AccountID: accountId,
          Symbol: symbol,
          Quantity: quantity.toString(),
          OrderType: 'Market',
          TradeAction: 'SELLTOCLOSE',
          TimeInForce: { Duration: 'DAY' },
          Route: 'Intelligent'
        };
        
        const sellResponse = await this.apiClient.placeOrder(sellOrder);
        if (sellResponse.success) {
          this.logger.info(`✅ Sell order placed to close position: ${sellResponse.data.OrderID}`);
        } else {
          this.logger.error(`❌ Failed to place sell order: ${sellResponse.error}`);
          throw new Error(`Failed to close filled position for ${symbol}`);
        }
      } else {
        this.logger.warn(`⚠️ Order ${orderId} status '${order.Status}' - no action needed`);
      }
      
    } catch (error) {
      this.logger.error(`❌ Exception handling order ${orderId}:`, error);
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
      
      // Update last data received time
      this.lastDataReceived = new Date();
      
      // Only update if this is a new bar (avoid duplicate ticks)
      if (!this.lastBarTimestamp || timestamp !== this.lastBarTimestamp) {
        this.currentSPXPrice = Number(bar.Close);
        this.lastBarTimestamp = timestamp;
        
        // Always log bar updates at info level during market hours for visibility
        const now = new Date();
        const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
        const hour = etNow.getHours();
        if (hour >= 9 && hour < 16) {
          this.logger.info(`📊 SPX Bar: ${timestamp} = $${this.currentSPXPrice.toFixed(2)} (O:${bar.Open} H:${bar.High} L:${bar.Low})`);
        } else {
          this.logger.debug(`📊 SPX Bar: ${timestamp} = $${this.currentSPXPrice.toFixed(2)} (O:${bar.Open} H:${bar.High} L:${bar.Low})`);
        }
        
        // Log significant price moves
        const priceChange = Math.abs(this.currentSPXPrice - Number(bar.Open));
        if (priceChange > 5) {
          this.logger.info(`📊 Significant SPX move: $${priceChange.toFixed(2)} in 1 minute to $${this.currentSPXPrice.toFixed(2)}`);
        }
      } else {
        // Log duplicate bars to detect if stream is stuck
        this.logger.debug(`📊 Duplicate bar timestamp: ${timestamp}`);
      }
    }
  }

  private getDataStreamStatus(): 'healthy' | 'warning' | 'critical' {
    const now = new Date();
    const timeSinceLastData = now.getTime() - this.lastDataReceived.getTime();
    
    // Check if we're during market hours
    const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const hour = etNow.getHours();
    const minute = etNow.getMinutes();
    const isMarketHours = (hour === 9 && minute >= 30) || (hour > 9 && hour < 16);
    
    if (isMarketHours) {
      if (timeSinceLastData > 120000) return 'critical'; // 2+ minutes
      if (timeSinceLastData > 90000) return 'warning'; // 1.5+ minutes
    }
    return 'healthy';
  }

  private checkHeartbeat(): void {
    const now = new Date();
    const timeSinceLastData = now.getTime() - this.lastDataReceived.getTime();
    const maxSilentTime = 90000; // 1.5 minutes (SPX bars should come every minute)
    
    // Check if we're during market hours
    const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const hour = etNow.getHours();
    const minute = etNow.getMinutes();
    const isMarketHours = (hour === 9 && minute >= 30) || (hour > 9 && hour < 16);
    
    // Always log data stream status at info level for visibility
    this.logger.info(`📊 Data stream check - Last data: ${Math.round(timeSinceLastData / 1000)}s ago | Last bar: ${this.lastBarTimestamp || 'None'} | SPX: $${this.currentSPXPrice.toFixed(2)}`);
    
    // During market hours, be more aggressive about reconnection
    const reconnectThreshold = isMarketHours ? 90000 : maxSilentTime;
    
    if (timeSinceLastData > reconnectThreshold) {
      this.logger.warn(`⚠️ No data received for ${Math.round(timeSinceLastData / 1000)} seconds - Stream may be dead`);
      
      // Emit critical event if heartbeat monitor is active
      if (this.heartbeatMonitor) {
        this.emit('dataStreamIssue', {
          timeSinceLastData,
          status: 'critical'
        });
      }
      
      // Force reconnection by unsubscribing first
      this.logger.info('Force reconnecting SPX stream...');
      if (this.spxSubscriptionId) {
        this.streamingClient.unsubscribe(this.spxSubscriptionId);
        this.spxSubscriptionId = null;
      }
      
      // Wait a second then resubscribe
      setTimeout(() => {
        this.subscribeToSPX().catch(error => {
          this.logger.error('Failed to reconnect SPX stream:', error);
        });
      }, 1000);
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
        TradeAction: 'SELLTOCLOSE',
        TimeInForce: { Duration: 'DAY' },
        Route: 'Intelligent'
      };
      
      // Place put closing order
      const putOrder: OrderRequest = {
        AccountID: accountId,
        Symbol: this.currentStraddle.putSymbol,
        Quantity: this.currentStraddle.quantity.toString(),
        OrderType: 'Market',
        TradeAction: 'SELLTOCLOSE',
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
      },
      heartbeat: this.heartbeatMonitor ? this.heartbeatMonitor.getHeartbeatStatus() : null
    };
  }
}