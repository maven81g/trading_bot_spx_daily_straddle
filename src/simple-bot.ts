// Simplified Trading Bot for Quick Testing
// Focused on streaming and basic authentication

import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { TradeStationClient } from './api/client';
import { createLogger } from './utils/logger';
import {
  TradeStationConfig,
  Account,
  Balance,
  Position,
  Bar,
  Quote
} from './types/tradestation';

export interface SimpleBotConfig {
  tradeStation: TradeStationConfig;
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    file?: string;
  };
}

export class SimpleBot extends EventEmitter {
  private config: SimpleBotConfig;
  private logger: Logger;
  private apiClient: TradeStationClient;
  private accounts: Account[] = [];
  private isRunning = false;

  constructor(config: SimpleBotConfig) {
    super();
    this.config = config;
    this.logger = createLogger('SimpleBot', config.logging);
    
    // Initialize components
    this.apiClient = new TradeStationClient(config.tradeStation);
    
    this.setupEventListeners();
  }

  async start(): Promise<void> {
    try {
      this.logger.info('🚀 Starting Simple Trading Bot...');
      
      // Step 1: Authenticate
      await this.authenticate();
      
      // Step 2: Load basic account data
      await this.loadAccounts();
      
      // Step 3: Ready for trading (no streaming in TradeStation simulation)
      
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
      
      // No streaming to cleanup
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

    // Authentication complete

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


  private setupEventListeners(): void {
    // API Client Events
    this.apiClient.on('authenticated', (token) => {
      this.logger.info('🔐 API authenticated');
    });

    this.apiClient.on('authError', (error) => {
      this.logger.error('🔐❌ Authentication error:', error);
      this.emit('error', error);
    });

    // No streaming events - TradeStation simulation doesn't support WebSocket
  }

  // Getters
  getAccounts(): Account[] {
    return [...this.accounts];
  }

  getRunningStatus(): boolean {
    return this.isRunning;
  }
}