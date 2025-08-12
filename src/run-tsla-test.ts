#!/usr/bin/env node

// TSLA Test Bot Launcher
// Simple buy and hold test to verify orders appear on trading platform

import 'dotenv/config';
import { TSLATestBot } from './tsla-test-bot';
import { createLogger } from './utils/logger';
import * as fs from 'fs';

const logger = createLogger('TSLATestRunner', { level: 'info' });

async function main() {
  try {
    console.log('🧪 TSLA Test Bot - Order Verification');
    console.log('=====================================');
    console.log('Purpose: Verify orders appear on TradeStation platform');
    console.log('Strategy: Buy TSLA, hold 10 minutes, sell\n');

    // Validate environment variables
    const requiredEnvVars = ['TRADESTATION_CLIENT_ID', 'TRADESTATION_CLIENT_SECRET', 'TRADESTATION_REFRESH_TOKEN'];
    const missing = requiredEnvVars.filter(env => !process.env[env]);
    
    if (missing.length > 0) {
      console.error('❌ Missing required environment variables:');
      missing.forEach(env => console.error(`   - ${env}`));
      console.error('\n💡 Copy env.example to .env and fill in your TradeStation credentials');
      process.exit(1);
    }

    // Ask user to confirm mode
    console.log('⚠️  TRADING MODE SELECTION:');
    console.log('   This test will place BUY and SELL orders for TSLA');
    console.log('   Choose your mode carefully:\n');
    console.log('   📄 PAPER TRADING: Safe simulation (recommended for testing)');  
    console.log('   💰 LIVE TRADING: Real money orders on your account\n');

    // Set to false for real orders on simulation account
    const paperTrading = false; // REAL orders on TradeStation SIMULATION account
    const quantity = 1; // 1 share for testing
    
    if (paperTrading) {
      console.log('✅ PAPER TRADING MODE selected - orders will be simulated');
    } else {
      console.log('🎯 SIMULATION ACCOUNT MODE - REAL orders on TradeStation simulation account');
      console.log('💡 Orders will appear in your TradeStation simulation account (not live account)');
      console.log('🔒 This uses sim-api.tradestation.com - safe for testing');
    }

    // Bot Configuration - Using SIMULATION API
    const config = {
      tradeStation: {
        baseUrl: 'https://sim-api.tradestation.com/v3', // SIMULATION API
        streamingUrl: '',
        clientId: process.env.TRADESTATION_CLIENT_ID!,
        clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
        redirectUri: '',
        scope: 'ReadAccount MarketData Trade', // Need Trade scope
        sandbox: true // Simulation mode
      },
      trading: {
        paperTrading,
        quantity,
        accountId: 'SIM2768516M' // Specific account for equity trading
      },
      logging: {
        level: (process.env.LOG_LEVEL as any) || 'info',
        file: process.env.LOG_FILE || './logs/tsla-test.log'
      }
    };

    console.log('\n📊 Test Configuration:');
    console.log(`   Symbol: TSLA`);
    console.log(`   Quantity: ${quantity} shares`);
    console.log(`   Hold Time: 10 minutes`);
    console.log(`   Mode: ${paperTrading ? 'Paper Trading (Safe)' : 'Simulation Account (Real Orders)'}`);
    console.log(`   API: ${config.tradeStation.baseUrl}`);
    console.log(`   Safety: Using TradeStation SIMULATION environment`);
    console.log('');

    // Create logs directory
    const logDir = './logs';
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Create bot instance
    const bot = new TSLATestBot(config);

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

    // Event listeners
    bot.on('started', () => {
      console.log('✅ TSLA Test Bot started successfully!');
    });

    bot.on('stopped', () => {
      console.log('\n🛑 TSLA Test Bot stopped');
    });

    bot.on('error', (error) => {
      console.error('❌ Bot error:', error instanceof Error ? error.message : String(error));
      logger.error('Bot error:', error);
    });

    // Start the bot
    console.log('🚀 Starting TSLA test...\n');
    await bot.start();

    // Status updates every 30 seconds during the test
    const statusInterval = setInterval(() => {
      const status = bot.getStatus();
      if (status.isRunning && status.buyTime) {
        const elapsed = Math.floor((new Date().getTime() - status.buyTime.getTime()) / 60000);
        const remaining = Math.max(0, 10 - elapsed);
        console.log(`📊 Status: TSLA position held for ${elapsed} min, ${remaining} min remaining`);
      }
    }, 30000);

    // Clean up interval when bot stops
    bot.on('stopped', () => {
      clearInterval(statusInterval);
    });
    
  } catch (error) {
    console.error('💥 Failed to start TSLA Test Bot:', error instanceof Error ? error.message : String(error));
    logger.error('Bot startup error:', error);
    process.exit(1);
  }
}

// Export for testing
export { main };

// Run if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Fatal test error:', error);
    process.exit(1);
  });
}