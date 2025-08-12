// TSLA Test Bot - Simple buy and hold for 10 minutes
// Purpose: Verify orders appear on trading platform

import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { TradeStationClient } from './api/client';
import { createLogger } from './utils/logger';
import {
  TradeStationConfig,
  Account
} from './types/tradestation';

interface TSLATestBotConfig {
  tradeStation: TradeStationConfig;
  trading: {
    paperTrading: boolean;
    quantity: number;
    accountId?: string;
  };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    file?: string;
  };
}

export class TSLATestBot extends EventEmitter {
  private config: TSLATestBotConfig;
  private logger: Logger;
  private apiClient: TradeStationClient;
  private accounts: Account[] = [];
  private isRunning = false;
  private orderId: string | null = null;
  private buyTime: Date | null = null;
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(config: TSLATestBotConfig) {
    super();
    this.config = config;
    this.logger = createLogger('TSLATestBot', config.logging);
    this.apiClient = new TradeStationClient(config.tradeStation);
  }

  async start(): Promise<void> {
    try {
      this.logger.info('🚀 Starting TSLA Test Bot...');
      console.log('🧪 TSLA Test Bot - Buy and Hold for 10 minutes');
      console.log('================================================');
      
      await this.authenticate();
      await this.loadAccounts();
      
      this.isRunning = true;
      this.logger.info('✅ TSLA Test Bot started successfully');
      this.emit('started');
      
      // Execute the test trade
      await this.executeTSLATest();
      
    } catch (error) {
      this.logger.error('❌ Failed to start TSLA Test Bot:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      this.logger.info('🛑 Stopping TSLA Test Bot...');
      
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
      
      this.apiClient.destroy();
      this.isRunning = false;
      
      this.logger.info('✅ TSLA Test Bot stopped');
      this.emit('stopped');
      
    } catch (error) {
      this.logger.error('❌ Error stopping TSLA Test Bot:', error);
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
    this.logger.info(`✅ Loaded ${this.accounts.length} accounts`);
    
    // Display account details to understand capabilities
    console.log(`\n📋 Available Accounts:`);
    this.accounts.forEach((account, index) => {
      console.log(`   ${index + 1}. Account: ${account.AccountID}`);
      console.log(`      Type: ${account.AccountType}`);
      console.log(`      Currency: ${account.Currency}`);
      console.log(`      Status: ${account.Status}`);
      if (account.AccountDetail) {
        console.log(`      Day Trading Qualified: ${account.AccountDetail.DayTradingQualified}`);
        console.log(`      Option Approval Level: ${account.AccountDetail.OptionApprovalLevel}`);
      }
    });
    
    // Check if specified account exists
    if (this.config.trading.accountId) {
      const specifiedAccount = this.accounts.find(acc => acc.AccountID === this.config.trading.accountId);
      if (specifiedAccount) {
        console.log(`\n✅ Using specified account: ${specifiedAccount.AccountID} (${specifiedAccount.AccountType})`);
        console.log(`   Status: ${specifiedAccount.Status}`);
      } else {
        console.log(`\n❌ Specified account ${this.config.trading.accountId} not found!`);
        console.log(`   Available accounts: ${this.accounts.map(a => a.AccountID).join(', ')}`);
        throw new Error(`Account ${this.config.trading.accountId} not found`);
      }
    } else if (this.accounts.length > 0) {
      this.config.trading.accountId = this.accounts[0].AccountID;
      console.log(`\n✅ Using first available account: ${this.accounts[0].AccountID} (${this.accounts[0].AccountType})`);
    }
  }

  private async executeTSLATest(): Promise<void> {
    console.log(`\n🎯 TSLA Test Parameters:`);
    console.log(`   Symbol: TSLA`);
    console.log(`   Quantity: ${this.config.trading.quantity} shares`);
    console.log(`   Hold Time: 10 minutes`);
    console.log(`   Paper Trading: ${this.config.trading.paperTrading ? 'YES (SAFE)' : 'NO (REAL MONEY)'}`);
    console.log(`   Account: ${this.config.trading.accountId}`);
    
    try {
      // Step 1: Buy TSLA
      console.log(`\n⏰ ${new Date().toLocaleTimeString()} - Placing BUY order for TSLA...`);
      const buySuccess = await this.placeBuyOrder();
      
      if (buySuccess) {
        this.buyTime = new Date();
        console.log(`✅ BUY order placed successfully at ${this.buyTime.toLocaleTimeString()}`);
        
        if (this.config.trading.paperTrading) {
          console.log(`📄 PAPER TRADE: This is a simulated order`);
        } else {
          console.log(`💰 LIVE TRADE: Check your TradeStation platform for the order`);
        }
        
        // Step 2: Set timer to sell after 10 minutes
        this.holdTimer = setTimeout(async () => {
          await this.sellTSLA();
        }, 10 * 60 * 1000); // 10 minutes
        
        console.log(`⏱️  Will sell TSLA in 10 minutes (at ${new Date(Date.now() + 10 * 60 * 1000).toLocaleTimeString()})`);
        
        // Show countdown every minute
        this.startCountdown();
        
      } else {
        console.log(`❌ Failed to place BUY order`);
        this.emit('error', new Error('Buy order failed'));
      }
      
    } catch (error) {
      console.log(`❌ Error executing TSLA test:`, error instanceof Error ? error.message : String(error));
      this.emit('error', error);
    }
  }

  private async placeBuyOrder(): Promise<boolean> {
    if (!this.config.trading.accountId) {
      console.log(`❌ No account ID available`);
      return false;
    }

    try {
      if (this.config.trading.paperTrading) {
        // Simulate paper trade
        this.orderId = `PAPER_BUY_TSLA_${Date.now()}`;
        this.logger.info(`📄 PAPER TRADE: BUY ${this.config.trading.quantity} TSLA @ MARKET`);
        return true;
      }
      
      // Place real order on simulation account
      console.log(`🔄 Placing REAL order on TradeStation simulation account...`);
      
      const orderRequest = {
        AccountID: this.config.trading.accountId,
        Symbol: 'TSLA',
        Quantity: this.config.trading.quantity.toString(),
        OrderType: 'Market' as const,
        TradeAction: 'BUY' as const,
        TimeInForce: {
          Duration: 'DAY' as const
        },
        Route: 'Intelligent'
      };
      
      console.log(`📤 Order Details:`, {
        Account: orderRequest.AccountID,
        Symbol: orderRequest.Symbol,
        Quantity: orderRequest.Quantity,
        Type: 'Market Buy',
        Duration: 'Day'
      });
      
      const response = await this.apiClient.placeOrder(orderRequest);
      
      if (response.success && response.data) {
        this.orderId = response.data.OrderID || `ORDER_${Date.now()}`;
        console.log(`✅ Order placed successfully!`);
        console.log(`📋 Order ID: ${this.orderId}`);
        console.log(`💡 Check your TradeStation simulation account for the order`);
        return true;
      } else {
        const errorMsg = response.error || response.data?.Error || 'Unknown error';
        const detailMsg = response.data?.Message || '';
        console.log(`❌ Order failed: ${errorMsg}`);
        if (detailMsg) {
          console.log(`📋 Details: ${detailMsg}`);
        }
        console.log(`📋 Full Response:`, response.data);
        return false;
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`❌ Error placing buy order:`, errorMessage);
      
      // Handle axios errors safely
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as any;
        console.log(`📋 HTTP Status:`, axiosError.response?.status);
        console.log(`📋 Response Data:`, axiosError.response?.data);
        console.log(`📋 Request URL:`, axiosError.config?.url);
        this.logger.error('Buy order error - Axios', {
          status: axiosError.response?.status,
          data: axiosError.response?.data,
          url: axiosError.config?.url,
          message: errorMessage
        });
      } else {
        this.logger.error('Buy order error', { message: errorMessage });
      }
      return false;
    }
  }

  private async sellTSLA(): Promise<void> {
    if (!this.buyTime) {
      console.log(`❌ No buy time recorded - cannot sell`);
      return;
    }
    
    const holdTimeMinutes = Math.floor((new Date().getTime() - this.buyTime.getTime()) / 60000);
    
    console.log(`\n⏰ ${new Date().toLocaleTimeString()} - 10 minutes elapsed, placing SELL order...`);
    
    try {
      if (this.config.trading.paperTrading) {
        console.log(`📄 PAPER TRADE: SELL ${this.config.trading.quantity} TSLA @ MARKET`);
        console.log(`✅ SELL order placed successfully`);
      } else {
        // Place real sell order on simulation account
        console.log(`🔄 Placing REAL SELL order on TradeStation simulation account...`);
        
        const sellOrderRequest = {
          AccountID: this.config.trading.accountId!,
          Symbol: 'TSLA',
          Quantity: this.config.trading.quantity.toString(),
          OrderType: 'Market' as const,
          TradeAction: 'SELL' as const,
          TimeInForce: {
            Duration: 'DAY' as const
          },
          Route: 'Intelligent'
        };
        
        console.log(`📤 SELL Order Details:`, {
          Account: sellOrderRequest.AccountID,
          Symbol: sellOrderRequest.Symbol,
          Quantity: sellOrderRequest.Quantity,
          Type: 'Market Sell',
          Duration: 'Day'
        });
        
        const sellResponse = await this.apiClient.placeOrder(sellOrderRequest);
        
        if (sellResponse.success && sellResponse.data) {
          console.log(`✅ SELL order placed successfully!`);
          console.log(`📋 Sell Order ID: ${sellResponse.data.OrderID}`);
          console.log(`💡 Check your TradeStation simulation account for the SELL order`);
        } else {
          console.log(`❌ SELL order failed:`, sellResponse.error || sellResponse.data?.Error || 'Unknown error');
          console.log(`📋 SELL Response:`, sellResponse.data);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`❌ Error placing sell order:`, errorMessage);
      
      // Handle axios errors safely
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as any;
        console.log(`📋 SELL HTTP Status:`, axiosError.response?.status);
        console.log(`📋 SELL Response Data:`, axiosError.response?.data);
        this.logger.error('Sell order error - Axios', {
          status: axiosError.response?.status,
          data: axiosError.response?.data,
          message: errorMessage
        });
      } else {
        this.logger.error('Sell order error', { message: errorMessage });
      }
    }
    
    console.log(`📊 Test Complete:`);
    console.log(`   Symbol: TSLA`);
    console.log(`   Quantity: ${this.config.trading.quantity} shares`);
    console.log(`   Hold Time: ${holdTimeMinutes} minutes`);
    console.log(`   Buy Time: ${this.buyTime.toLocaleTimeString()}`);
    console.log(`   Sell Time: ${new Date().toLocaleTimeString()}`);
    
    // Auto-stop the bot after completing the test
    setTimeout(() => {
      console.log(`\n🏁 TSLA test completed - stopping bot in 30 seconds...`);
      setTimeout(async () => {
        await this.stop();
        process.exit(0);
      }, 30000);
    }, 5000);
  }

  private startCountdown(): void {
    let minutesRemaining = 10;
    
    const countdownInterval = setInterval(() => {
      minutesRemaining--;
      if (minutesRemaining > 0) {
        console.log(`⏱️  ${minutesRemaining} minutes remaining until SELL...`);
      } else {
        clearInterval(countdownInterval);
      }
    }, 60000); // Every minute
  }

  // Status method
  getStatus(): any {
    return {
      isRunning: this.isRunning,
      symbol: 'TSLA',
      quantity: this.config.trading.quantity,
      buyTime: this.buyTime,
      orderId: this.orderId,
      paperTrading: this.config.trading.paperTrading,
      accountId: this.config.trading.accountId
    };
  }

  getAccounts(): Account[] {
    return [...this.accounts];
  }
}