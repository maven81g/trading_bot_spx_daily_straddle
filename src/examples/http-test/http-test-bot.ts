// HTTP Streaming Test Bot
// Tests TradeStation's HTTP streaming (not WebSocket)

import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { TradeStationClient } from '../../api/client';
import { TradeStationHttpStreaming } from '../../api/http-streaming';
import { createLogger } from '../../utils/logger';
import {
  TradeStationConfig,
  Account,
  Bar,
  Quote
} from '../../types/tradestation';

export interface HttpTestBotConfig {
  tradeStation: TradeStationConfig;
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    file?: string;
  };
}

export class HttpTestBot extends EventEmitter {
  private config: HttpTestBotConfig;
  private logger: Logger;
  private apiClient: TradeStationClient;
  private streamingClient: TradeStationHttpStreaming;
  private accounts: Account[] = [];
  private isRunning = false;

  constructor(config: HttpTestBotConfig) {
    super();
    this.config = config;
    this.logger = createLogger('HttpTestBot', config.logging);
    
    // Initialize components
    this.apiClient = new TradeStationClient(config.tradeStation);
    this.streamingClient = new TradeStationHttpStreaming(config.tradeStation, this.apiClient);
    
    this.setupEventListeners();
  }

  async start(): Promise<void> {
    try {
      this.logger.info('🚀 Starting HTTP Streaming Test Bot...');
      
      // Step 1: Authenticate
      await this.authenticate();
      
      // Step 2: Load accounts  
      await this.loadAccounts();
      
      // Step 3: Test HTTP streaming with SPX
      await this.testHttpStreaming();
      
      this.isRunning = true;
      this.logger.info('✅ HTTP Streaming Test Bot started successfully');
      this.emit('started');
      
    } catch (error) {
      this.logger.error('❌ Failed to start HTTP Streaming Test Bot:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      this.logger.info('🛑 Stopping HTTP Streaming Test Bot...');
      
      this.streamingClient.unsubscribeAll();
      this.streamingClient.destroy();
      this.apiClient.destroy();
      
      this.isRunning = false;
      this.logger.info('✅ HTTP Streaming Test Bot stopped');
      this.emit('stopped');
      
    } catch (error) {
      this.logger.error('❌ Error stopping HTTP Streaming Test Bot:', error);
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
  }

  private async testHttpStreaming(): Promise<void> {
    this.logger.info('🔄 Testing HTTP streaming with correct symbols...');
    
    // Test different SPX symbol formats
    const testSymbols = [
      '$SPX.X',    // Standard SPX (from documentation)
      '$SPXW.X',   // Weekly SPX options (from documentation)
      'SPY',       // SPY ETF (should work)
      'AAPL'       // Popular stock (should work)
    ];

    for (const symbol of testSymbols) {
      try {
        this.logger.info(`📊 Testing HTTP streaming for: ${symbol}`);
        
        const subscriptionId = await this.streamingClient.subscribeToBars({
          symbol,
          interval: 1,
          unit: 'Minute'
        });
        
        this.logger.info(`✅ Successfully subscribed to ${symbol}: ${subscriptionId}`);
        
        // Test for 30 seconds then unsubscribe
        setTimeout(() => {
          this.streamingClient.unsubscribe(subscriptionId);
          this.logger.info(`📊 Unsubscribed from ${symbol} after test period`);
        }, 30000);
        
      } catch (error) {
        this.logger.error(`❌ Failed to subscribe to ${symbol}:`, error instanceof Error ? error.message : String(error));
      }
      
      // Wait 2 seconds between tests
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  private setupEventListeners(): void {
    // API Client Events
    this.apiClient.on('authenticated', (token) => {
      this.logger.info('🔐 API authenticated');
      this.streamingClient.setAuthToken(token);
    });

    this.apiClient.on('authError', (error) => {
      this.logger.error('🔐❌ Authentication error:', error);
      this.emit('error', error);
    });

    // HTTP Streaming Events  
    this.streamingClient.on('bar', (data) => {
      this.logger.info('📊 Bar received via HTTP streaming:', {
        symbol: data.symbol,
        close: data.bar.Close,
        time: data.bar.TimeStamp
      });
      console.log(`📊 HTTP BAR: ${data.symbol} = $${parseFloat(data.bar.Close).toFixed(2)} @ ${new Date(data.bar.TimeStamp).toLocaleTimeString()}`);
    });

    this.streamingClient.on('quote', (data) => {
      this.logger.info('💱 Quote received via HTTP streaming:', {
        symbol: data.symbol,
        last: data.quote.Last,
        time: data.quote.TradeTime
      });
      console.log(`💱 HTTP QUOTE: ${data.symbol} = $${parseFloat(data.quote.Last).toFixed(2)}`);
    });

    this.streamingClient.on('error', (error) => {
      this.logger.error('📡❌ HTTP Streaming error:', error);
      console.log(`❌ HTTP Streaming Error: ${JSON.stringify(error)}`);
    });
  }

  // Getters
  getAccounts(): Account[] {
    return [...this.accounts];
  }

  getRunningStatus(): boolean {
    return this.isRunning;
  }
}