#!/usr/bin/env node

import 'dotenv/config';
import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { TradeStationClient } from './api/client';
import { TradeStationHttpStreaming } from './api/http-streaming';
import { createLogger } from './utils/logger';
import { HeartbeatMonitor } from './utils/heartbeat-monitor';
import { BigQuery } from '@google-cloud/bigquery';
import { StateManager, BotState, PositionState } from './utils/state-manager';
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
    limitOrderBuffer?: number; // Buffer amount for limit orders (e.g., 0.25)
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
  callEntryPrice: number;  // Quoted price at entry
  putEntryPrice: number;   // Quoted price at entry
  totalEntryPrice: number; // Quoted total
  callFillPrice?: number;  // Actual fill price from TradeStation
  putFillPrice?: number;   // Actual fill price from TradeStation
  totalFillPrice?: number; // Actual total fill price
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
  private stateManager: StateManager;
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
  private currentCallBid = 0;
  private currentCallAsk = 0;
  private currentPutBid = 0;
  private currentPutAsk = 0;
  
  // Bar consolidation for SPX price
  private lastBarTimestamp: string | null = null;
  
  // Timing
  private entryCheckInterval: NodeJS.Timeout | null = null;
  private positionMonitorInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastDataReceived: Date = new Date();
  
  // Entry protection flags
  private isEnteringPosition: boolean = false;
  private lastEntryDate: string | null = null;
  private entryAttemptCount: number = 0;

  constructor(config: StraddleBotConfig) {
    super();
    this.config = config;
    this.logger = createLogger('SPXStraddleBot', config.logging);
    
    this.apiClient = new TradeStationClient(config.tradeStation);
    this.streamingClient = new TradeStationHttpStreaming(config.tradeStation, this.apiClient);
    this.stateManager = new StateManager('./bot-state.json', this.logger);
    
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
      
      // Recover state from previous session
      await this.recoverState();
      
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
      
      // If we have a recovered position, subscribe to option quotes
      if (this.currentStraddle && this.currentStraddle.isOpen) {
        this.logger.info('🔗 Subscribing to quotes for recovered position...');
        await this.subscribeToOptions(this.currentStraddle.callSymbol, this.currentStraddle.putSymbol);
      }
      
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
    
    // Save current state before shutdown (DO NOT close positions)
    if (this.currentStraddle && this.currentStraddle.isOpen) {
      this.logger.info('📝 Saving open position state before shutdown...');
      await this.saveState();
      this.logger.info(`💾 Position saved: ${this.currentStraddle.strike} straddle (${this.currentStraddle.callSymbol}/${this.currentStraddle.putSymbol})`);
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
      this.checkMarketCloseShutdown();
    }, 30000); // Every 30 seconds
    
    // Wait a bit for SPX price to arrive, then check
    setTimeout(() => {
      this.checkEntryTime();
    }, 5000); // Check after 5 seconds (enough time for first SPX bar)
  }

  private checkMarketCloseShutdown(): void {
    const now = new Date();
    const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const currentHour = etNow.getHours();
    const currentMinute = etNow.getMinutes();
    
    // Check if it's 4:05 PM EST (16:05 in 24-hour format)
    if (currentHour === 16 && currentMinute >= 5) {
      this.logger.info('🕐 Market closed at 4:05 PM EST - Shutting down bot');
      this.logDailySummary();
      
      // Gracefully stop the bot
      this.stop().then(() => {
        this.logger.info('✅ Bot shutdown complete');
        process.exit(0);
      }).catch((error) => {
        this.logger.error('Error during shutdown:', error);
        process.exit(1);
      });
    }
  }

  private roundToOptionIncrement(price: number): string {
    // SPX options trade in $0.05 increments for prices under $3, $0.10 increments above $3
    // For most SPX straddles, we'll use $0.05 increments
    const increment = price >= 3 ? 0.10 : 0.05;
    const rounded = Math.round(price / increment) * increment;
    return rounded.toFixed(2);
  }

  private async waitForOrderFills(orderIds: string[], timeoutMs: number = 60000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds
    
    this.logger.info(`⏳ Checking fills for orders: ${orderIds.join(', ')}`);
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const allFilled = await this.checkOrdersFilled(orderIds);
        
        if (allFilled) {
          return true;
        }
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        
      } catch (error) {
        this.logger.error('Error checking order fills:', error);
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
    }
    
    this.logger.warn(`⏰ Fill confirmation timeout after ${timeoutMs}ms`);
    return false;
  }

  private async checkOrdersFilled(orderIds: string[]): Promise<boolean> {
    try {
      // Get all orders and find our specific order IDs
      const accountId = this.config.trading.accountId || this.accounts[0].AccountID;
      const ordersResponse = await this.apiClient.getOrders(accountId);
      
      if (!ordersResponse.success) {
        this.logger.error('Failed to get orders:', ordersResponse.error);
        return false;
      }
      
      const orders = ordersResponse.data;
      
      let allFilled = true;
      let filledCount = 0;
      
      for (const orderId of orderIds) {
        // Find the order by ID
        const order = orders.find((o: any) => o.OrderID === orderId);
        
        if (order) {
          const status = order.Status;
          const filled = parseFloat(order.FilledQuantity || '0');
          const total = parseFloat(order.Quantity || '1');
          
          this.logger.debug(`Order ${orderId}: Status=${status}, Filled=${filled}/${total}`);
          
          if (status === 'FIL' || status === 'Filled' || filled >= total) {
            filledCount++;
            
            // For filled orders, we need to get the actual fill price from positions or order details
            // For now, we'll use the limit price as approximation until we get actual fills
            if (this.currentStraddle) {
              let fillPrice = 0;
              
              // Try to use limit price as approximation for now
              if (order.LimitPrice) {
                fillPrice = parseFloat(order.LimitPrice);
              }
              
              if (orderId === this.currentStraddle.callOrderId) {
                this.currentStraddle.callFillPrice = fillPrice;
                this.logger.info(`📈 Call order filled (Order: ${orderId}, approx price: $${fillPrice})`);
              } else if (orderId === this.currentStraddle.putOrderId) {
                this.currentStraddle.putFillPrice = fillPrice;
                this.logger.info(`📉 Put order filled (Order: ${orderId}, approx price: $${fillPrice})`);
              }
              
              // Update total fill price if both orders are filled
              if (this.currentStraddle.callFillPrice && this.currentStraddle.putFillPrice) {
                this.currentStraddle.totalFillPrice = this.currentStraddle.callFillPrice + this.currentStraddle.putFillPrice;
                this.logger.info(`💰 Total estimated fill price: $${this.currentStraddle.totalFillPrice.toFixed(2)}`);
              }
            }
          } else if (status === 'REJ' || status === 'Rejected') {
            this.logger.error(`❌ Order ${orderId} was REJECTED: ${order.StatusDescription}`);
            allFilled = false;
          } else {
            allFilled = false;
          }
        } else {
          this.logger.error(`Order ${orderId} not found in account orders`);
          allFilled = false;
        }
      }
      
      if (filledCount > 0) {
        this.logger.info(`📊 Fill progress: ${filledCount}/${orderIds.length} orders filled`);
      }
      
      return allFilled;
      
    } catch (error) {
      this.logger.error('Error checking order fills:', error);
      return false;
    }
  }

  private async handleUnfilledOrders(orderIds: string[]): Promise<void> {
    this.logger.warn(`🔍 Handling unfilled orders: ${orderIds.join(', ')}`);
    
    try {
      const accountId = this.config.trading.accountId || this.accounts[0].AccountID;
      const ordersResponse = await this.apiClient.getOrders(accountId);
      
      if (!ordersResponse.success) {
        this.logger.error('Failed to get orders for cleanup:', ordersResponse.error);
        return;
      }
      
      const orders = ordersResponse.data;
      
      for (const orderId of orderIds) {
        const order = orders.find((o: any) => o.OrderID === orderId);
        
        if (order) {
          const status = order.Status;
          
          this.logger.info(`Order ${orderId} status: ${status} - ${order.StatusDescription}`);
          
          // Cancel if still pending
          if (status === 'ACK' || status === 'Acknowledged' || status === 'PEN' || status === 'Pending') {
            this.logger.warn(`🚫 Cancelling unfilled order: ${orderId}`);
            try {
              await this.apiClient.cancelOrder(orderId);
            } catch (error) {
              this.logger.error(`Failed to cancel order ${orderId}:`, error);
            }
          }
        } else {
          this.logger.warn(`Order ${orderId} not found for cleanup`);
        }
      }
    } catch (error) {
      this.logger.error('Error in handleUnfilledOrders:', error);
    }
  }

  private confirmFillsInBackground(orderIds: string[]): void {
    this.logger.info(`🔄 Starting background fill confirmation for orders: ${orderIds.join(', ')}`);
    
    // Run fill confirmation without blocking position monitoring
    this.waitForOrderFills(orderIds, 60000)
      .then((fillsConfirmed) => {
        if (fillsConfirmed) {
          this.logger.info(`✅ Background fill confirmation successful - Updated to actual fill prices`);
        } else {
          this.logger.warn(`⚠️ Background fill confirmation timeout - Continuing with quoted prices`);
          this.logger.info(`📊 Position remains active using quoted prices for P&L calculations`);
          
          // Check if orders were rejected (but don't cancel position unless all rejected)
          this.checkOrderStatusForWarnings(orderIds);
        }
      })
      .catch((error) => {
        this.logger.error('Background fill confirmation error:', error);
        this.logger.info(`📊 Position continues using quoted prices due to confirmation error`);
      });
  }

  private async checkOrderStatusForWarnings(orderIds: string[]): Promise<void> {
    try {
      const accountId = this.config.trading.accountId || this.accounts[0].AccountID;
      const ordersResponse = await this.apiClient.getOrders(accountId);
      
      if (!ordersResponse.success) {
        this.logger.error('Failed to check order status for warnings:', ordersResponse.error);
        return;
      }
      
      const orders = ordersResponse.data;
      let rejectedCount = 0;
      
      for (const orderId of orderIds) {
        const order = orders.find((o: any) => o.OrderID === orderId);
        
        if (order && (order.Status === 'REJ' || order.Status === 'Rejected')) {
          rejectedCount++;
          this.logger.warn(`⚠️ Order ${orderId} was rejected: ${order.StatusDescription}`);
        }
      }
      
      // If all orders were rejected, we have a problem
      if (rejectedCount === orderIds.length) {
        this.logger.error(`🚨 ALL ORDERS REJECTED - Position may not exist but bot is tracking with quoted prices!`);
        this.logger.error(`🔧 Consider manual intervention or position verification`);
      }
      
    } catch (error) {
      this.logger.error('Error checking order status for warnings:', error);
    }
  }

  private checkEntryTime(): void {
    if (this.currentStraddle && this.currentStraddle.isOpen) {
      return; // Already have a position
    }
    
    // Check if we're already entering a position
    if (this.isEnteringPosition) {
      this.logger.debug('Already entering position, skipping duplicate entry check');
      return;
    }
    
    const now = new Date();
    const [entryHour, entryMinute] = this.config.strategy.entryTime.split(':').map(Number);
    
    // Convert to ET
    const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const currentHour = etNow.getHours();
    const currentMinute = etNow.getMinutes();
    const todayDateStr = etNow.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Check if we already entered today
    if (this.lastEntryDate === todayDateStr) {
      this.logger.debug(`Already attempted entry today (${todayDateStr}), skipping`);
      return;
    }
    
    // Log current check status
    this.logger.debug(`Entry check: ${currentHour}:${String(currentMinute).padStart(2, '0')} ET | Target: ${entryHour}:${String(entryMinute).padStart(2, '0')} | SPX: $${this.currentSPXPrice.toFixed(2)}`);
    
    // Check if it's within 1 minute of entry time
    if (currentHour === entryHour && Math.abs(currentMinute - entryMinute) <= 1) {
      this.logger.info(`🎯 Entry time reached at ${etNow.toLocaleTimeString('en-US', {timeZone: 'America/New_York'})}`);
      
      // Make sure we have SPX price
      if (!this.currentSPXPrice || this.currentSPXPrice === 0) {
        this.logger.warn(`⚠️ Entry time reached but no SPX price yet. Waiting for price data...`);
        return;
      }
      
      // Set protection flags BEFORE entering
      this.isEnteringPosition = true;
      this.lastEntryDate = todayDateStr;
      this.entryAttemptCount++;
      
      this.logger.info(`🔒 Entry lock engaged - Attempt #${this.entryAttemptCount} for ${todayDateStr}`);
      
      this.enterStraddle();
    }
  }

  private async enterStraddle(): Promise<void> {
    // Set a timeout to release the lock after 2 minutes (safety mechanism)
    const lockTimeout = setTimeout(() => {
      if (this.isEnteringPosition) {
        this.logger.warn('⚠️ Entry lock timeout - releasing lock after 2 minutes');
        this.isEnteringPosition = false;
      }
    }, 120000); // 2 minutes
    
    try {
      if (!this.currentSPXPrice || this.currentSPXPrice < 3000 || this.currentSPXPrice > 10000) {
        this.logger.error(`Invalid SPX price: ${this.currentSPXPrice}, skipping entry`);
        this.isEnteringPosition = false; // Release lock on error
        clearTimeout(lockTimeout);
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
        this.isEnteringPosition = false; // Release lock on error
        clearTimeout(lockTimeout);
        return;
      }
      
      const callQuote = callQuoteResponse.data;
      const putQuote = putQuoteResponse.data;
      
      // Log the quote details and store bid/ask
      this.logger.info(`Call quote - Symbol: ${callSymbol}, Bid: ${callQuote.Bid}, Ask: ${callQuote.Ask}, Last: ${callQuote.Last}`);
      this.logger.info(`Put quote - Symbol: ${putSymbol}, Bid: ${putQuote.Bid}, Ask: ${putQuote.Ask}, Last: ${putQuote.Last}`);
      
      // Store bid/ask for limit order calculations
      this.currentCallBid = Number(callQuote.Bid || 0);
      this.currentCallAsk = Number(callQuote.Ask || 0);
      this.currentPutBid = Number(putQuote.Bid || 0);
      this.currentPutAsk = Number(putQuote.Ask || 0);
      
      const callPrice = Number(callQuote.Ask || callQuote.Last || 0);
      const putPrice = Number(putQuote.Ask || putQuote.Last || 0);
      const totalPrice = callPrice + putPrice;
      
      if (totalPrice <= 0) {
        this.logger.error('Invalid option prices, skipping entry');
        this.isEnteringPosition = false; // Release lock on error
        clearTimeout(lockTimeout);
        return;
      }
      
      // Calculate position size - Always 1 contract each (call + put = 1 straddle)
      const quantity = 1;
      const totalCost = totalPrice * this.config.trading.contractMultiplier; // Total cost for 1 straddle
      
      // Check if we have enough capital for 1 straddle
      if (totalCost > this.config.trading.maxPositionValue) {
        this.logger.error(`Straddle too expensive: $${totalCost.toFixed(2)} > Max $${this.config.trading.maxPositionValue}`);
        this.isEnteringPosition = false; // Release lock on error
        clearTimeout(lockTimeout);
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
        // For paper trading, emit success immediately
        this.logger.info('PAPER TRADE: Straddle entered (no real orders placed)');
        this.totalTrades++;
        this.emit('straddleOpened', this.currentStraddle);
        
        // Save state after opening position
        await this.saveState();
        
        // Release the entry lock for paper trading
        this.isEnteringPosition = false;
        clearTimeout(lockTimeout);
        this.logger.info(`🔓 Entry lock released after paper trade entry`);
      }
      
      // Subscribe to option quotes for monitoring
      await this.subscribeToOptions(callSymbol, putSymbol);
      
      // Clear the timeout since we completed successfully
      clearTimeout(lockTimeout);
      
    } catch (error) {
      this.logger.error('Failed to enter straddle:', error);
      // Clear position if straddle creation failed
      this.currentStraddle = null;
      
      // Release the entry lock on error
      this.isEnteringPosition = false;
      clearTimeout(lockTimeout);
      this.logger.info(`🔓 Entry lock released after enterStraddle error`);
      
      this.emit('error', error);
    }
  }

  private async placeStraddleOrders(): Promise<void> {
    if (!this.currentStraddle) return;
    
    let callOrderId: string | null = null;
    let putOrderId: string | null = null;
    
    try {
      const accountId = this.config.trading.accountId || this.accounts[0].AccountID;
      const buffer = this.config.trading.limitOrderBuffer || 0.25;
      
      // Calculate limit prices (mid + buffer for buying)
      const callMid = (this.currentCallBid + this.currentCallAsk) / 2;
      const putMid = (this.currentPutBid + this.currentPutAsk) / 2;
      // Round to nearest $0.05 (SPX options trade in $0.05 increments)
      const callLimit = this.roundToOptionIncrement(callMid + buffer);
      const putLimit = this.roundToOptionIncrement(putMid + buffer);
      
      this.logger.info(`📊 Order prices - Call: Mid=${callMid.toFixed(2)} Limit=${callLimit} | Put: Mid=${putMid.toFixed(2)} Limit=${putLimit}`);
      
      // Place call order with limit
      const callOrder: OrderRequest = {
        AccountID: accountId,
        Symbol: this.currentStraddle.callSymbol,
        Quantity: this.currentStraddle.quantity.toString(),
        OrderType: 'Limit',
        LimitPrice: callLimit,
        TradeAction: 'BUYTOOPEN',
        TimeInForce: { Duration: 'DAY' },
        Route: 'Intelligent'
      };
      
      // Place put order with limit
      const putOrder: OrderRequest = {
        AccountID: accountId,
        Symbol: this.currentStraddle.putSymbol,
        Quantity: this.currentStraddle.quantity.toString(),
        OrderType: 'Limit',
        LimitPrice: putLimit,
        TradeAction: 'BUYTOOPEN',
        TimeInForce: { Duration: 'DAY' },
        Route: 'Intelligent'
      };
      
      const [callResponse, putResponse] = await Promise.all([
        this.apiClient.placeOrder(callOrder),
        this.apiClient.placeOrder(putOrder)
      ]);
      
      // Log detailed responses for debugging
      this.logger.info(`Call order response - Success: ${callResponse.success}, Data: ${JSON.stringify(callResponse.data)}`);
      this.logger.info(`Put order response - Success: ${putResponse.success}, Data: ${JSON.stringify(putResponse.data)}`);
      
      // Track successful orders for potential rollback
      if (callResponse.success) {
        // TradeStation API returns OrderID in Orders array
        if (callResponse.data?.Orders && Array.isArray(callResponse.data.Orders) && callResponse.data.Orders.length > 0) {
          callOrderId = callResponse.data.Orders[0].OrderID;
        } else {
          // Fallback to check direct properties
          callOrderId = callResponse.data?.OrderID;
        }
        
        if (!callOrderId) {
          this.logger.error(`⚠️ Call order response missing OrderID. Full response: ${JSON.stringify(callResponse.data)}`);
        } else {
          this.logger.info(`✅ Call order placed successfully: ${callOrderId}`);
        }
      } else {
        this.logger.error(`❌ Call order failed: ${JSON.stringify(callResponse.error || callResponse.data)}`);
      }
      
      if (putResponse.success) {
        // TradeStation API returns OrderID in Orders array
        if (putResponse.data?.Orders && Array.isArray(putResponse.data.Orders) && putResponse.data.Orders.length > 0) {
          putOrderId = putResponse.data.Orders[0].OrderID;
        } else {
          // Fallback to check direct properties
          putOrderId = putResponse.data?.OrderID;
        }
        
        if (!putOrderId) {
          this.logger.error(`⚠️ Put order response missing OrderID. Full response: ${JSON.stringify(putResponse.data)}`);
        } else {
          this.logger.info(`✅ Put order placed successfully: ${putOrderId}`);
        }
      } else {
        this.logger.error(`❌ Put order failed: ${JSON.stringify(putResponse.error || putResponse.data)}`);
      }
      
      // Both orders must succeed and have valid IDs
      if (callResponse.success && putResponse.success && callOrderId && putOrderId) {
        this.currentStraddle.callOrderId = callOrderId;
        this.currentStraddle.putOrderId = putOrderId;
        
        this.logger.info(`📋 Both orders submitted - Call: ${callOrderId}, Put: ${putOrderId}`);
        this.logger.info(`⏳ Waiting for fill confirmation before considering position open...`);
        
        this.logger.info(`✅ Orders submitted - Starting position monitoring with quoted prices`);
        
        // Immediately emit success and start monitoring with quoted prices
        this.totalTrades++;
        this.emit('straddleOpened', this.currentStraddle);
        
        // Save state immediately after order submission
        await this.saveState();
        
        // Release the entry lock after successful order placement
        this.isEnteringPosition = false;
        this.logger.info(`🔓 Entry lock released after successful order placement`);
        
        // Start fill confirmation in background (don't await)
        this.confirmFillsInBackground([callOrderId, putOrderId]);
        
        // Set up a one-time fill check after 5 seconds to persist state with fill prices
        setTimeout(async () => {
          if (this.currentStraddle && this.currentStraddle.isOpen) {
            // Use the existing updateFillPrices method to check for actual fill prices
            await this.updateFillPrices();
            // Save state again with any fill prices we found
            await this.saveState();
            this.logger.info('💾 State saved with fill prices');
          }
        }, 5000);
        
      } else {
        // Log specific failure reason
        if (!callResponse.success || !putResponse.success) {
          this.logger.error(`Order placement failed - Call: ${callResponse.success ? 'OK' : 'FAILED'}, Put: ${putResponse.success ? 'OK' : 'FAILED'}`);
        } else if (!callOrderId || !putOrderId) {
          this.logger.error(`Orders succeeded but missing IDs - Call ID: ${callOrderId || 'MISSING'}, Put ID: ${putOrderId || 'MISSING'}`);
        }
        
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
        
        // Release the entry lock on failure
        this.isEnteringPosition = false;
        this.logger.info(`🔓 Entry lock released after order failure`);
        
        throw new Error(`Orders failed - Call: ${callResponse.success ? (callOrderId ? 'OK' : 'NO_ID') : 'FAILED'}, Put: ${putResponse.success ? (putOrderId ? 'OK' : 'NO_ID') : 'FAILED'}`);
      }
      
    } catch (error) {
      this.logger.error('Failed to place straddle orders:', error);
      
      // Release the entry lock on exception
      this.isEnteringPosition = false;
      this.logger.info(`🔓 Entry lock released after exception`);
      
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

  private async recoverState(): Promise<void> {
    try {
      // First, load saved state for basic stats
      const state = await this.stateManager.initialize();
      if (state) {
        this.logger.info('📂 Loading previous session data...');
        this.dailyPnL = state.dailyPnL || 0;
        this.totalTrades = state.totalTrades || 0;
        this.closedPositions = state.closedPositions.map(p => this.positionStateToStraddle(p));
        
        // Restore current position if it exists
        if (state.currentPosition) {
          this.currentStraddle = this.positionStateToStraddle(state.currentPosition);
          this.logger.info(`🔄 Restored current position: ${this.currentStraddle.strike} straddle (${this.currentStraddle.callSymbol}/${this.currentStraddle.putSymbol})`);
        }
        
        if (state.currentSPXPrice) {
          this.currentSPXPrice = state.currentSPXPrice;
        }
      }
      
      // Then, check TradeStation for actual open positions (this is authoritative)
      await this.recoverFromBrokerPositions();
      
      // Note: Quote subscription will happen after authentication
      
    } catch (error) {
      this.logger.warn('Failed to recover state, starting fresh:', error);
    }
  }
  
  private async recoverFromBrokerPositions(): Promise<void> {
    try {
      this.logger.info('🔍 Checking TradeStation for open positions...');
      
      // Display saved position info first if we have it
      if (this.currentStraddle) {
        this.logger.info('📋 Saved position details:');
        this.logger.info(`   Strike: ${this.currentStraddle.strike}`);
        this.logger.info(`   Call: ${this.currentStraddle.callSymbol}`);
        this.logger.info(`   Put: ${this.currentStraddle.putSymbol}`);
        this.logger.info(`   Entry: $${this.currentStraddle.totalEntryPrice.toFixed(2)} (Call: $${this.currentStraddle.callEntryPrice.toFixed(2)}, Put: $${this.currentStraddle.putEntryPrice.toFixed(2)})`);
        if (this.currentStraddle.callFillPrice || this.currentStraddle.putFillPrice) {
          this.logger.info(`   Fills: Call: $${this.currentStraddle.callFillPrice?.toFixed(2) || 'pending'}, Put: $${this.currentStraddle.putFillPrice?.toFixed(2) || 'pending'}`);
        }
      }
      
      // Get current positions from TradeStation
      const accountIds = this.accounts.map(a => a.AccountID);
      if (accountIds.length === 0) {
        this.logger.warn('No accounts available to check positions');
        return;
      }
      
      const positionsResponse = await this.apiClient.getPositions(accountIds);
      if (!positionsResponse.success || !positionsResponse.data) {
        this.logger.info('✅ No open positions found on TradeStation');
        // If we have a saved position but no broker positions, log a warning
        if (this.currentStraddle) {
          this.logger.warn('⚠️ Saved position exists but not found on TradeStation - keeping saved position');
        }
        return;
      }
      
      const positions = positionsResponse.data;
      
      // Look for SPX option positions
      const spxPositions = positions.filter(p => 
        p.Symbol.includes('SPXW') && 
        p.AssetType === 'STOCKOPTION' &&
        parseFloat(p.Quantity) > 0
      );
      
      if (spxPositions.length === 0) {
        this.logger.info('✅ No SPX option positions found on TradeStation');
        // If we have a saved position but no broker positions, log a warning
        if (this.currentStraddle) {
          this.logger.warn('⚠️ Saved position exists but not found on TradeStation');
          this.logger.warn('   This could mean:');
          this.logger.warn('   1. Position was closed while bot was down');
          this.logger.warn('   2. Position expired');
          this.logger.warn('   3. Account mismatch');
          this.logger.info('🔄 Keeping saved position for reference - will be cleared at next entry time');
        }
        return;
      }
      
      // Try to identify straddle pairs
      const straddle = await this.identifyStraddleFromPositions(spxPositions);
      if (straddle) {
        // Check if this matches our saved position
        if (this.currentStraddle && 
            this.currentStraddle.callSymbol === straddle.callSymbol && 
            this.currentStraddle.putSymbol === straddle.putSymbol) {
          this.logger.info('✅ TradeStation positions match saved state - using saved position with broker data validation');
          // Keep the saved position but validate against broker data
        } else {
          // New or different position found on broker
          this.currentStraddle = straddle;
          this.logger.info('🔄 Updated position from TradeStation (different from saved state)');
        }
        this.logger.info('🎯 RECOVERED ACTIVE STRADDLE FROM TRADESTATION:');
        this.logger.info(`   Call: ${straddle.callSymbol} @ $${straddle.callEntryPrice.toFixed(2)}`);
        this.logger.info(`   Put: ${straddle.putSymbol} @ $${straddle.putEntryPrice.toFixed(2)}`);
        this.logger.info(`   Total Entry: $${straddle.totalEntryPrice.toFixed(2)}`);
        this.logger.info(`   Strike: ${straddle.strike}`);
        this.logger.info(`   Quantity: ${straddle.quantity}`);
        
        // Subscribe to quotes for monitoring
        await this.subscribeToOptions(straddle.callSymbol, straddle.putSymbol);
      } else {
        this.logger.info(`ℹ️ Found ${spxPositions.length} SPX positions but couldn't identify as straddle`);
        // Log individual positions for debugging
        spxPositions.forEach(pos => {
          this.logger.info(`   ${pos.Symbol}: ${pos.Quantity} @ $${pos.AveragePrice}`);
        });
      }
      
    } catch (error) {
      this.logger.error('Failed to recover from broker positions:', error);
    }
  }
  
  private async identifyStraddleFromPositions(positions: Position[]): Promise<StraddlePosition | null> {
    // Group by expiration and strike to find potential straddles
    const grouped = new Map<string, Position[]>();
    
    for (const pos of positions) {
      // Parse symbol: SPXW 250827C6465 or SPXW 250827P6465
      const match = pos.Symbol.match(/SPXW (\d{6})([CP])(\d+)/);
      if (!match) continue;
      
      const [, expiration, type, strike] = match;
      const key = `${expiration}_${strike}`;
      
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(pos);
    }
    
    // Look for pairs with same strike and expiration
    for (const [key, posGroup] of grouped) {
      if (posGroup.length !== 2) continue;
      
      const callPos = posGroup.find(p => p.Symbol.includes('C'));
      const putPos = posGroup.find(p => p.Symbol.includes('P'));
      
      if (!callPos || !putPos) continue;
      
      // Ensure same quantity (straddle)
      if (callPos.Quantity !== putPos.Quantity) continue;
      
      // Extract strike from symbol
      const match = callPos.Symbol.match(/SPXW \d{6}[CP](\d+)/);
      if (!match) continue;
      
      const strike = parseInt(match[1]);
      const quantity = parseFloat(callPos.Quantity);
      const callEntryPrice = parseFloat(callPos.AveragePrice);
      const putEntryPrice = parseFloat(putPos.AveragePrice);
      const totalEntryPrice = callEntryPrice + putEntryPrice;
      
      // Calculate target and stop prices based on config
      const targetPrice = totalEntryPrice * (1 + this.config.strategy.targetProfitPercent / 100);
      const stopPrice = this.config.strategy.stopLossPercent 
        ? totalEntryPrice * (1 - this.config.strategy.stopLossPercent / 100)
        : undefined;
      
      return {
        entryTime: new Date(), // We don't know exact entry time, use current
        spxPrice: this.currentSPXPrice || strike, // Approximate
        strike,
        callSymbol: callPos.Symbol,
        putSymbol: putPos.Symbol,
        callEntryPrice,
        putEntryPrice,
        totalEntryPrice,
        callFillPrice: callEntryPrice, // These ARE the actual fill prices
        putFillPrice: putEntryPrice,
        totalFillPrice: totalEntryPrice,
        quantity,
        targetPrice,
        stopPrice,
        isOpen: true
      };
    }
    
    return null;
  }

  private positionStateToStraddle(pos: PositionState): StraddlePosition {
    return {
      entryTime: new Date(pos.entryTime),
      spxPrice: pos.spxPrice,
      strike: pos.strike,
      callSymbol: pos.callSymbol,
      putSymbol: pos.putSymbol,
      callEntryPrice: pos.callEntryPrice,
      putEntryPrice: pos.putEntryPrice,
      totalEntryPrice: pos.totalEntryPrice,
      callFillPrice: (pos as any).callFillPrice,
      putFillPrice: (pos as any).putFillPrice, 
      totalFillPrice: (pos as any).totalFillPrice,
      quantity: pos.quantity,
      targetPrice: pos.targetPrice,
      stopPrice: pos.stopPrice,
      callOrderId: pos.callOrderId,
      putOrderId: pos.putOrderId,
      isOpen: pos.isOpen,
      exitReason: pos.exitReason as any,
      exitTime: pos.exitTime ? new Date(pos.exitTime) : undefined,
      callExitPrice: pos.callExitPrice,
      putExitPrice: pos.putExitPrice,
      totalExitPrice: pos.totalExitPrice,
      pnl: pos.pnl
    };
  }

  private straddleToPositionState(straddle: StraddlePosition): PositionState {
    return {
      entryTime: straddle.entryTime.toISOString(),
      spxPrice: straddle.spxPrice,
      strike: straddle.strike,
      callSymbol: straddle.callSymbol,
      putSymbol: straddle.putSymbol,
      callEntryPrice: straddle.callEntryPrice,
      putEntryPrice: straddle.putEntryPrice,
      totalEntryPrice: straddle.totalEntryPrice,
      quantity: straddle.quantity,
      targetPrice: straddle.targetPrice,
      stopPrice: straddle.stopPrice,
      callOrderId: straddle.callOrderId,
      putOrderId: straddle.putOrderId,
      isOpen: straddle.isOpen,
      exitReason: straddle.exitReason,
      exitTime: straddle.exitTime?.toISOString(),
      callExitPrice: straddle.callExitPrice,
      putExitPrice: straddle.putExitPrice,
      totalExitPrice: straddle.totalExitPrice,
      pnl: straddle.pnl,
      ...(straddle.callFillPrice && { callFillPrice: straddle.callFillPrice }),
      ...(straddle.putFillPrice && { putFillPrice: straddle.putFillPrice }),
      ...(straddle.totalFillPrice && { totalFillPrice: straddle.totalFillPrice })
    } as any;
  }

  private async saveState(): Promise<void> {
    try {
      const state: BotState = {
        version: '1.0',
        lastSaved: new Date().toISOString(),
        dailyPnL: this.dailyPnL,
        totalTrades: this.totalTrades,
        currentPosition: this.currentStraddle ? this.straddleToPositionState(this.currentStraddle) : undefined,
        closedPositions: this.closedPositions.map(p => this.straddleToPositionState(p)),
        lastDataReceived: this.lastDataReceived.toISOString(),
        currentSPXPrice: this.currentSPXPrice
      };
      
      await this.stateManager.save(state);
    } catch (error) {
      this.logger.error('Failed to save state:', error);
    }
  }

  private async updateFillPrices(): Promise<void> {
    if (!this.currentStraddle || this.currentStraddle.totalFillPrice) {
      return; // Already have fill prices
    }
    
    try {
      // Get fill prices from positions API (more reliable than orders API for fill prices)
      const accountIds = this.accounts.map(a => a.AccountID);
      if (accountIds.length === 0) return;
      
      const positionsResponse = await this.apiClient.getPositions(accountIds);
      if (!positionsResponse.success || !positionsResponse.data) return;
      
      const positions = positionsResponse.data;
      
      // Find our specific positions by symbol
      const callPosition = positions.find(p => p.Symbol === this.currentStraddle!.callSymbol);
      const putPosition = positions.find(p => p.Symbol === this.currentStraddle!.putSymbol);
      
      let updated = false;
      
      // Update call fill price from position
      if (callPosition && !this.currentStraddle.callFillPrice) {
        const fillPrice = parseFloat(callPosition.AveragePrice);
        if (fillPrice > 0) {
          this.currentStraddle.callFillPrice = fillPrice;
          updated = true;
          this.logger.info(`📊 Call fill price updated: $${fillPrice.toFixed(2)} (quoted: $${this.currentStraddle.callEntryPrice.toFixed(2)})`);
        }
      }
      
      // Update put fill price from position
      if (putPosition && !this.currentStraddle.putFillPrice) {
        const fillPrice = parseFloat(putPosition.AveragePrice);
        if (fillPrice > 0) {
          this.currentStraddle.putFillPrice = fillPrice;
          updated = true;
          this.logger.info(`📊 Put fill price updated: $${fillPrice.toFixed(2)} (quoted: $${this.currentStraddle.putEntryPrice.toFixed(2)})`);
        }
      }
      
      // Update total fill price if both are available
      if (this.currentStraddle.callFillPrice && this.currentStraddle.putFillPrice && !this.currentStraddle.totalFillPrice) {
        this.currentStraddle.totalFillPrice = this.currentStraddle.callFillPrice + this.currentStraddle.putFillPrice;
        const difference = this.currentStraddle.totalFillPrice - this.currentStraddle.totalEntryPrice;
        this.logger.info(`📊 Total fill price: $${this.currentStraddle.totalFillPrice.toFixed(2)} (quoted: $${this.currentStraddle.totalEntryPrice.toFixed(2)}, diff: $${difference.toFixed(2)})`);
        
        // Save state when we get actual fill prices
        await this.saveState();
      }
      
    } catch (error) {
      this.logger.debug('Error updating fill prices:', error);
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
        this.currentCallBid = Number(quote.Bid || this.currentCallBid);
        this.currentCallAsk = Number(quote.Ask || this.currentCallAsk);
        this.logger.debug(`Call update: ${symbol} = Last:$${this.currentCallPrice} Bid:$${this.currentCallBid} Ask:$${this.currentCallAsk}`);
      } else if (symbol === this.currentStraddle.putSymbol) {
        this.currentPutPrice = Number(quote.Last || quote.Close || this.currentPutPrice);
        this.currentPutBid = Number(quote.Bid || this.currentPutBid);
        this.currentPutAsk = Number(quote.Ask || this.currentPutAsk);
        this.logger.debug(`Put update: ${symbol} = Last:$${this.currentPutPrice} Bid:$${this.currentPutBid} Ask:$${this.currentPutAsk}`);
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
    
    // Only log data stream issues during market hours to avoid pre-market errors
    if (isMarketHours) {
      this.logger.info(`📊 Data stream check - Last data: ${Math.round(timeSinceLastData / 1000)}s ago | Last bar: ${this.lastBarTimestamp || 'None'} | SPX: $${this.currentSPXPrice.toFixed(2)}`);
    } else {
      this.logger.debug(`📊 Pre-market check - Last data: ${Math.round(timeSinceLastData / 1000)}s ago | SPX: $${this.currentSPXPrice.toFixed(2)}`);
    }
    
    // During market hours, be more aggressive about reconnection
    const reconnectThreshold = isMarketHours ? 90000 : maxSilentTime;
    
    // Only trigger reconnection during market hours
    if (isMarketHours && timeSinceLastData > reconnectThreshold) {
      this.logger.warn(`⚠️ No data received for ${Math.round(timeSinceLastData / 1000)} seconds during market hours - Stream may be dead`);
      
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
    
    // Update fill prices if not yet captured
    if (!this.currentStraddle.totalFillPrice) {
      await this.updateFillPrices();
    }
    
    // Use bid prices for accurate P&L and exit decisions (what we'd actually get if we sold)
    const totalBidPrice = this.currentCallBid + this.currentPutBid;
    const totalLastPrice = this.currentCallPrice + this.currentPutPrice;
    
    if (totalBidPrice <= 0) {
      return; // No valid prices yet
    }
    
    const entryPrice = this.currentStraddle.totalFillPrice || this.currentStraddle.totalEntryPrice;
    const pnl = (totalBidPrice - entryPrice) * this.currentStraddle.quantity * this.config.trading.contractMultiplier;
    const pnlPercent = ((totalBidPrice - entryPrice) / entryPrice) * 100;
    
    this.logger.debug(`Position monitor - Bid: $${totalBidPrice.toFixed(2)}, Last: $${totalLastPrice.toFixed(2)}, P&L: $${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}%)`);
    
    // Check exit conditions using bid prices
    // 1. Target profit hit (use actual entry price for accurate targeting)
    const actualTargetPrice = entryPrice * (1 + this.config.strategy.targetProfitPercent / 100);
    if (totalBidPrice >= actualTargetPrice) {
      this.logger.info(`TARGET HIT at ${totalBidPrice.toFixed(2)} (${pnlPercent.toFixed(1)}% profit) - Target was $${actualTargetPrice.toFixed(2)}`);
      await this.closeStraddle('TARGET');
    }
    // 2. Stop loss hit (use actual entry price for accurate stop loss)
    const actualStopPrice = this.config.strategy.stopLossPercent 
      ? entryPrice * (1 - this.config.strategy.stopLossPercent / 100)
      : null;
    if (actualStopPrice && totalBidPrice <= actualStopPrice) {
      this.logger.info(`STOP LOSS HIT at ${totalBidPrice.toFixed(2)} (${pnlPercent.toFixed(1)}% loss) - Stop was $${actualStopPrice.toFixed(2)}`);
      await this.closeStraddle('STOP');
    }
    // 3. End of day exit
    else {
      const now = new Date();
      const [exitHour, exitMinute] = this.config.strategy.exitTime.split(':').map(Number);
      const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
      
      if (etNow.getHours() >= exitHour && etNow.getMinutes() >= exitMinute) {
        this.logger.info(`END OF DAY EXIT at ${totalBidPrice.toFixed(2)} (${pnlPercent.toFixed(1)}%)`);
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
      const actualEntryPrice = this.currentStraddle.totalFillPrice || this.currentStraddle.totalEntryPrice;
      this.currentStraddle.pnl = (this.currentStraddle.totalExitPrice - actualEntryPrice) * 
                                  this.currentStraddle.quantity * this.config.trading.contractMultiplier;
      this.currentStraddle.isOpen = false;
      
      // Place closing orders if not paper trading
      if (!this.config.trading.paperTrading) {
        await this.placeClosingOrders(reason);
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
      
      // Save state after closing position
      await this.saveState();
      
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

  private async placeClosingOrders(reason: 'TARGET' | 'STOP' | 'EOD' | 'MANUAL_STOP'): Promise<void> {
    if (!this.currentStraddle) return;
    
    try {
      const accountId = this.config.trading.accountId || this.accounts[0].AccountID;
      const buffer = this.config.trading.limitOrderBuffer || 0.25;
      
      // Determine order type based on exit reason
      // Use market orders for stop loss, limit orders for target and EOD
      const useLimit = reason === 'TARGET' || reason === 'EOD';
      
      let callOrder: OrderRequest;
      let putOrder: OrderRequest;
      
      if (useLimit) {
        // Calculate limit prices (mid - buffer for selling)
        const callMid = (this.currentCallBid + this.currentCallAsk) / 2;
        const putMid = (this.currentPutBid + this.currentPutAsk) / 2;
        // Round to nearest $0.05 and don't go below bid
        const callLimit = this.roundToOptionIncrement(Math.max(this.currentCallBid, callMid - buffer));
        const putLimit = this.roundToOptionIncrement(Math.max(this.currentPutBid, putMid - buffer));
        
        this.logger.info(`📊 Exit limit prices - Call: Mid=${callMid.toFixed(2)} Limit=${callLimit} | Put: Mid=${putMid.toFixed(2)} Limit=${putLimit}`);
        
        // Place call closing order with limit
        callOrder = {
          AccountID: accountId,
          Symbol: this.currentStraddle.callSymbol,
          Quantity: this.currentStraddle.quantity.toString(),
          OrderType: 'Limit',
          LimitPrice: callLimit,
          TradeAction: 'SELLTOCLOSE',
          TimeInForce: { Duration: 'DAY' },
          Route: 'Intelligent'
        };
        
        // Place put closing order with limit
        putOrder = {
          AccountID: accountId,
          Symbol: this.currentStraddle.putSymbol,
          Quantity: this.currentStraddle.quantity.toString(),
          OrderType: 'Limit',
          LimitPrice: putLimit,
          TradeAction: 'SELLTOCLOSE',
          TimeInForce: { Duration: 'DAY' },
          Route: 'Intelligent'
        };
      } else {
        // Use market orders for stop loss
        this.logger.info(`⚠️ Using market orders for ${reason} exit`);
        
        callOrder = {
          AccountID: accountId,
          Symbol: this.currentStraddle.callSymbol,
          Quantity: this.currentStraddle.quantity.toString(),
          OrderType: 'Market',
          TradeAction: 'SELLTOCLOSE',
          TimeInForce: { Duration: 'DAY' },
          Route: 'Intelligent'
        };
        
        putOrder = {
          AccountID: accountId,
          Symbol: this.currentStraddle.putSymbol,
          Quantity: this.currentStraddle.quantity.toString(),
          OrderType: 'Market',
          TradeAction: 'SELLTOCLOSE',
          TimeInForce: { Duration: 'DAY' },
          Route: 'Intelligent'
        };
      }
      
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
        fillPrice: this.currentStraddle.totalFillPrice,
        // Use bid prices for more accurate P&L (what you'd get if you sold now)
        currentPrice: this.currentCallBid + this.currentPutBid,
        entryTime: this.currentStraddle.entryTime.toISOString(),
        // Calculate P&L using bid prices vs entry price
        unrealizedPnL: ((this.currentCallBid + this.currentPutBid) - (this.currentStraddle.totalFillPrice || this.currentStraddle.totalEntryPrice)) * 
                       this.currentStraddle.quantity * this.config.trading.contractMultiplier,
        targetPrice: this.currentStraddle.targetPrice,
        stopPrice: this.currentStraddle.stopPrice,
        quotedPrices: {
          call: this.currentStraddle.callEntryPrice,
          put: this.currentStraddle.putEntryPrice,
          total: this.currentStraddle.totalEntryPrice
        },
        fillPrices: this.currentStraddle.totalFillPrice ? {
          call: this.currentStraddle.callFillPrice,
          put: this.currentStraddle.putFillPrice,
          total: this.currentStraddle.totalFillPrice
        } : null
      } : null,
      closedPositions: this.closedPositions.length,
      activePositions: this.currentStraddle && this.currentStraddle.isOpen ? [{
        symbol: `SPX ${this.currentStraddle.strike} Straddle`,
        quantity: this.currentStraddle.quantity,
        side: 'LONG',
        unrealizedPnL: ((this.currentCallPrice + this.currentPutPrice) - (this.currentStraddle.totalFillPrice || this.currentStraddle.totalEntryPrice)) * 
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