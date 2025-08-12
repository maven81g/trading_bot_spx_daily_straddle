#!/usr/bin/env node

// Trading Bot - Simplified with Direct Configuration
// Uses refresh token authentication like the backtest

import 'dotenv/config';
import { TradingBot, BotConfig } from './bot';
import { createLogger } from './utils/logger';
import * as fs from 'fs';

const logger = createLogger('TradingBot', { level: 'info' });

async function main() {
  try {
    console.log('🚀 Starting SPX Trading Bot...');
    console.log('==============================\n');

    // Validate environment variables
    const requiredEnvVars = ['TRADESTATION_CLIENT_ID', 'TRADESTATION_CLIENT_SECRET', 'TRADESTATION_REFRESH_TOKEN'];
    const missing = requiredEnvVars.filter(env => !process.env[env]);
    
    if (missing.length > 0) {
      console.error('❌ Missing required environment variables:');
      missing.forEach(env => console.error(`   - ${env}`));
      console.error('\n💡 Copy env.example to .env and fill in your TradeStation credentials');
      process.exit(1);
    }

    // Create simplified bot configuration - ONE PLACE ONLY
    const config: BotConfig = {
      tradeStation: {
        baseUrl: 'https://sim-api.tradestation.com/v3',
        clientId: process.env.TRADESTATION_CLIENT_ID!,
        clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
        redirectUri: '',
        scope: 'ReadAccount',
        sandbox: true
      },
      strategies: [
        {
          id: 'spx-backtest-strategy',
          name: 'SPX Options Backtest Strategy',
          type: 'SPX_BACKTEST',
          enabled: true,
          symbols: ['$SPXW.X'],
          timeframe: '1min',
          parameters: {
            macdFastPeriod: 12,
            macdSlowPeriod: 26,
            macdSignalPeriod: 9,
            macdThreshold: -1.0,
            profitTarget: 1.0,
            stopLossPercentage: 0.20
          },
          entryConditions: {
            long: { id: 'entry-long', name: 'Long Entry', operator: 'AND', conditions: [] }
          },
          exitConditions: {
            long: { id: 'exit-long', name: 'Long Exit', operator: 'AND', conditions: [] }
          },
          riskManagement: {
            maxPositionSize: 10000,
            maxPositionSizeType: 'dollars' as const
          },
          positionSizing: {
            method: 'fixed' as const,
            baseAmount: 5000
          },
          execution: {
            orderType: 'Market' as const,
            timeInForce: 'DAY' as const
          }
        }
      ],
      riskManagement: {
        maxDailyLoss: parseInt(process.env.MAX_DAILY_LOSS || '1000'),
        maxDrawdown: parseInt(process.env.MAX_DRAWDOWN || '2000'),
        maxPositionsPerSymbol: 1,
        maxTotalPositions: parseInt(process.env.MAX_POSITIONS || '5')
      },
      execution: {
        paperTrading: process.env.PAPER_TRADING !== 'false',
        orderTimeout: 30000,
        maxSlippage: 0.01
      },
      logging: {
        level: (process.env.LOG_LEVEL as any) || 'info',
        file: process.env.LOG_FILE || './logs/trading-bot.log'
      }
    };

    console.log('📊 SPX Trading Bot Configuration:');
    console.log(`   Mode: Testing/Development`);
    console.log(`   API: ${config.tradeStation.sandbox ? 'Simulation' : 'Production'}`);
    console.log(`   Trading: ${config.execution.paperTrading ? 'Paper Trading' : 'Live Trading'}`);
    console.log(`   Strategy: SPX Options (MACD ${config.strategies[0]?.parameters?.macdThreshold || 'N/A'})`);
    console.log(`   Log Level: ${config.logging.level}`);
    console.log('');

    // Create logs directory if needed
    const logDir = './logs';
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Create bot instance
    const bot = new TradingBot(config);

    // Setup signal handlers for graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Received SIGINT, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      console.error('💥 Uncaught Exception:', error.message);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection:', reason);
      console.error('💥 Unhandled Rejection:', reason);
      process.exit(1);
    });

    // Enhanced event listeners
    bot.on('started', (state) => {
      console.log('✅ Trading Bot started successfully!');
      console.log(`📊 Status: ${state.status}`);
      console.log(`📈 Accounts: ${state.accounts.length}`);
      console.log(`🎯 Active Strategies: ${state.activeStrategies.size}`);
      console.log('\n🔄 Bot is running... Press Ctrl+C to stop.\n');
    });

    bot.on('stopped', (state) => {
      console.log('\n🛑 Trading Bot stopped');
      console.log(`💰 Total P&L: $${state.totalPnL.toFixed(2)}`);
      console.log(`📅 Daily P&L: $${state.dailyPnL.toFixed(2)}`);
    });

    bot.on('error', (error) => {
      console.error('❌ Trading Bot error:', error.message);
      logger.error('Bot error:', error);
    });

    bot.on('heartbeat', (state) => {
      // Only log heartbeat in debug mode
      if (config.logging.level === 'debug') {
        console.log(`💓 Heartbeat - Status: ${state.status}, P&L: $${state.totalPnL.toFixed(2)}`);
      }
    });

    bot.on('riskViolation', (violation) => {
      console.log('⚠️ Risk violation detected:', violation);
      logger.warn('Risk violation:', violation);
    });

    // Start the bot
    await bot.start();

    // Start demo mode if enabled
    if (process.env.DEMO_MODE === 'true') {
      console.log('🎭 Starting demo mode with sample SPX data...');
      startDemoMode(bot);
    }

  } catch (error) {
    console.error('💥 Failed to start Trading Bot:', error instanceof Error ? error.message : String(error));
    logger.error('Startup error:', error);
    process.exit(1);
  }
}

// Demo mode function to simulate SPX data
function startDemoMode(bot: TradingBot): void {
  let currentPrice = 5847.25; // Starting SPX price
  let bars: any[] = [];
  
  // Generate initial bars for MACD calculation
  for (let i = 0; i < 26; i++) {
    const price = currentPrice + (Math.random() - 0.5) * 10;
    const bar = {
      Open: (currentPrice - 2).toString(),
      High: (price + 5).toString(),
      Low: (price - 5).toString(),
      Close: price.toString(),
      TimeStamp: new Date(Date.now() - (26 - i) * 60000).toISOString(),
      TotalVolume: '1250000',
      Epoch: Date.now() - (26 - i) * 60000,
      IsRealtime: true,
      IsEndOfHistory: false,
      BarStatus: 'Close'
    };
    bars.push(bar);
    currentPrice = price;
  }
  
  let barIndex = 0;
  
  // Send historical bars first
  console.log('📊 Loading historical data for MACD calculation...');
  bars.forEach((bar, index) => {
    setTimeout(() => {
      bot.simulateBarData({ symbol: '$SPXW.X', bar });
    }, index * 100);
  });
  
  // Start live simulation after initial data
  setTimeout(() => {
    console.log('🔴 Starting live SPX data simulation...');
    
    const interval = setInterval(() => {
      // Simulate realistic price movement
      const change = (Math.random() - 0.5) * 5;
      currentPrice = Math.max(5800, Math.min(5900, currentPrice + change));
      
      const bar = {
        Open: (currentPrice - Math.random() * 3).toString(),
        High: (currentPrice + Math.random() * 3).toString(),
        Low: (currentPrice - Math.random() * 3).toString(),
        Close: currentPrice.toString(),
        TimeStamp: new Date().toISOString(),
        TotalVolume: Math.floor(1000000 + Math.random() * 500000).toString(),
        Epoch: Date.now(),
        IsRealtime: true,
        IsEndOfHistory: false,
        BarStatus: 'Close'
      };
      
      // Simulate bar update
      bot.simulateBarData({ symbol: '$SPXW.X', bar });
      
    }, 3000); // New bar every 3 seconds
    
    // Stop after 5 minutes for demo
    setTimeout(() => {
      clearInterval(interval);
      console.log('🎭 Demo mode ended after 5 minutes');
    }, 300000);
    
  }, 3000); // Wait 3 seconds for initial data to load
}

// Export for testing
export { main };

// Run if this file is executed directly  
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Fatal startup error:', error);
    process.exit(1);
  });
}