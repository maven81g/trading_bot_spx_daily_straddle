#!/usr/bin/env node

// Simple Trading Bot Launcher
// Runs the SPX strategy with HTTP streaming

import 'dotenv/config';
import { SimpleTradingBot } from './simple-trading-bot';
import { TradingDashboard } from './dashboard';
import { createLogger } from './utils/logger';
import * as fs from 'fs';

const logger = createLogger('SimpleBotRunner', { level: 'info' });

async function main() {
  try {
    console.log('🤖 SPX Simple Trading Bot');
    console.log('==========================');
    console.log('Strategy: SPX MACD Momentum with Options Trading\n');

    // Validate environment variables
    const requiredEnvVars = ['TRADESTATION_CLIENT_ID', 'TRADESTATION_CLIENT_SECRET', 'TRADESTATION_REFRESH_TOKEN'];
    const missing = requiredEnvVars.filter(env => !process.env[env]);
    
    if (missing.length > 0) {
      console.error('❌ Missing required environment variables:');
      missing.forEach(env => console.error(`   - ${env}`));
      console.error('\n💡 Copy env.example to .env and fill in your TradeStation credentials');
      process.exit(1);
    }

    // Bot Configuration
    const config = {
      tradeStation: {
        baseUrl: 'https://api.tradestation.com/v3',
        streamingUrl: '',
        clientId: process.env.TRADESTATION_CLIENT_ID!,
        clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
        redirectUri: '',
        scope: 'ReadAccount MarketData',
        sandbox: false
      },
      strategy: {
        spxSymbol: '$SPXW.X',          // SPX Weekly options underlying
        macdFastPeriod: 12,            // Proven backtest parameters
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        macdThreshold: -1.0,           // Entry threshold (must be <= this)
        profitTarget: 100.0,           // $100 profit target (1 contract * $100)
        stopLossPercentage: 0.20       // 20% stop loss
      },
      trading: {
        paperTrading: true,            // SAFE: Paper trading mode
        maxPositions: 1,               // Single position strategy
        accountId: undefined           // Will use first account found
      },
      logging: {
        level: (process.env.LOG_LEVEL as any) || 'info',
        file: process.env.LOG_FILE || './logs/simple-bot.log'
      }
    };

    console.log('📊 Strategy Configuration:');
    console.log(`   SPX Symbol: ${config.strategy.spxSymbol}`);
    console.log(`   MACD: ${config.strategy.macdFastPeriod}/${config.strategy.macdSlowPeriod}/${config.strategy.macdSignalPeriod}`);
    console.log(`   MACD Threshold: ${config.strategy.macdThreshold}`);
    console.log(`   Profit Target: $${config.strategy.profitTarget}`);
    console.log(`   Stop Loss: ${config.strategy.stopLossPercentage * 100}%`);
    console.log(`   Paper Trading: ${config.trading.paperTrading ? '✅ YES (SAFE)' : '❌ NO (REAL MONEY)'}`);
    console.log('');

    // Create logs directory
    const logDir = './logs';
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Create bot instance
    const bot = new SimpleTradingBot(config);
    
    // Create dashboard for real-time monitoring
    const dashboard = new TradingDashboard(bot, {
      updateInterval: 10,     // Update every 10 seconds
      showDetailedLogs: false,
      clearScreen: true
    });

    // Setup signal handlers for graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Received SIGINT, shutting down gracefully...');
      dashboard.stop();
      await bot.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
      dashboard.stop();
      await bot.stop();
      process.exit(0);
    });

    // Event listeners for logging (dashboard handles display)
    bot.on('error', (error) => {
      logger.error('Bot error:', error);
    });

    // Start the bot
    await bot.start();
    
    // Start the dashboard after bot starts
    setTimeout(() => {
      dashboard.start();
    }, 2000); // Small delay to let initial startup complete
    
  } catch (error) {
    console.error('💥 Failed to start Simple Trading Bot:', error instanceof Error ? error.message : String(error));
    logger.error('Bot startup error:', error);
    process.exit(1);
  }
}

// Export for testing
export { main };

// Run if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Fatal bot error:', error);
    process.exit(1);
  });
}