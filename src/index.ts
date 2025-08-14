#!/usr/bin/env node

// Trading Bot Main Entry Point
// Supports both local execution and Cloud Run HTTP mode

import 'dotenv/config';
import { TradingBot, TradingBotConfig } from './trading-bot';
import { createLogger } from './utils/logger';
import * as fs from 'fs';
import express from 'express';

const logger = createLogger('BotIndex', { level: 'info' });
const isCloudRun = process.env.RUNNING_IN_CLOUD === 'true';

async function runLocalBot() {
  try {
    console.log('🤖 SPX Trading Bot');
    console.log('==================');
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
    const config: TradingBotConfig = {
      tradeStation: {
        baseUrl: process.env.TRADESTATION_API_URL || 'https://sim-api.tradestation.com/v3',
        streamingUrl: '',
        clientId: process.env.TRADESTATION_CLIENT_ID!,
        clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
        redirectUri: '',
        scope: 'ReadAccount MarketData',
        sandbox: process.env.TRADESTATION_SANDBOX !== 'false'
      },
      strategy: {
        spxSymbol: '$SPXW.X',
        macdFastPeriod: 12,
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        macdThreshold: -1.0,
        profitTarget: 100.0,
        stopLossPercentage: 0.20
      },
      trading: {
        paperTrading: process.env.PAPER_TRADING !== 'false',
        maxPositions: 1,
        accountId: process.env.TRADESTATION_ACCOUNT_ID
      },
      logging: {
        level: process.env.TESTING === 'true' ? 'debug' : (process.env.LOG_LEVEL as any) || 'info',
        file: process.env.LOG_FILE || './logs/trading-bot.log'
      }
    };

    console.log('📊 Configuration:');
    console.log(`   API: ${config.tradeStation.sandbox ? 'Sandbox' : 'Production'}`);
    console.log(`   Paper Trading: ${config.trading.paperTrading ? '✅ YES (SAFE)' : '❌ NO (REAL MONEY)'}`);
    console.log(`   MACD: ${config.strategy.macdFastPeriod}/${config.strategy.macdSlowPeriod}/${config.strategy.macdSignalPeriod}`);
    console.log(`   Profit Target: $${config.strategy.profitTarget}`);
    console.log(`   Stop Loss: ${config.strategy.stopLossPercentage * 100}%`);
    console.log('');

    // Create logs directory
    const logDir = './logs';
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Create bot instance
    const bot = new TradingBot(config);

    // Setup signal handlers
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
      console.log('✅ Trading Bot started successfully!');
      console.log('🔄 Bot is running... Press Ctrl+C to stop.\n');
    });

    bot.on('stopped', () => {
      console.log('\n🛑 Trading Bot stopped');
    });

    bot.on('error', (error) => {
      console.error('❌ Trading Bot error:', error instanceof Error ? error.message : String(error));
      logger.error('Bot error:', error);
    });

    bot.on('positionOpened', (position) => {
      console.log(`📈 Position opened: ${position.symbol} @ $${position.entryPrice.toFixed(2)}`);
    });

    bot.on('positionClosed', (position) => {
      console.log(`📉 Position closed: ${position.symbol} | P&L: $${position.pnl.toFixed(2)}`);
    });

    // Start the bot
    await bot.start();

    // Add periodic dashboard-style status logging for local testing (every 2 minutes)
    console.log('\n📊 Dashboard mode enabled - Status updates every 2 minutes');
    console.log('🔍 Verbose logging enabled for strategy verification\n');
    
    setInterval(async () => {
      try {
        const status = await bot.getDetailedStatus();
        
        console.log('\n╔══════════════════════════════════════════════════════════════╗');
        console.log('║                  📊 TRADING BOT STATUS                        ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log(`║ ⏰ Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET | Uptime: ${status.uptime.padEnd(20)}║`);
        console.log(`║ 📈 Trades: ${status.totalTrades.toString().padEnd(3)} | Daily P&L: $${status.dailyPnL.toFixed(2).padEnd(10)}            ║`);
        console.log('╠══════════════════════════════════════════════════════════════╣');
        
        if (status.currentPosition) {
          console.log('║ 🎯 ACTIVE POSITION:                                          ║');
          console.log(`║   Symbol: ${status.currentPosition.symbol.padEnd(20)}                       ║`);
          console.log(`║   Entry: $${status.currentPosition.entryPrice.toFixed(2)} | Current: $${(status.currentPosition.currentPrice || 0).toFixed(2)}                    ║`);
          console.log(`║   P&L: $${(status.currentPosition.unrealizedPnL || 0).toFixed(2)} (${((status.currentPosition.unrealizedPnL || 0) / (status.currentPosition.entryPrice * 100) * 100).toFixed(1)}%)                                   ║`);
          const holdTime = Math.floor((Date.now() - new Date(status.currentPosition.entryTime).getTime()) / 60000);
          console.log(`║   Hold Time: ${holdTime} minutes                                      ║`);
        } else {
          console.log('║ 🎯 No active positions - Monitoring for signals...           ║');
        }
        
        console.log('╚══════════════════════════════════════════════════════════════╝\n');
      } catch (error) {
        console.error('Error getting status:', error);
      }
    }, 2 * 60 * 1000); // Every 2 minutes for testing

    // Keep the process alive
    setInterval(() => {
      // Heartbeat
    }, 30000);

  } catch (error) {
    console.error('💥 Failed to start Trading Bot:', error instanceof Error ? error.message : String(error));
    logger.error('Startup error:', error);
    process.exit(1);
  }
}

// Cloud Run HTTP Server Mode
async function startCloudServer() {
  const app = express();
  app.use(express.json());
  
  let bot: TradingBot | null = null;
  let botStatus = 'stopped';
  let statusInterval: NodeJS.Timeout | null = null;
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });
  
  // Status endpoint - returns detailed status
  app.get('/status', async (req, res) => {
    if (bot && botStatus === 'running') {
      const detailedStatus = await bot.getDetailedStatus();
      res.json(detailedStatus);
    } else {
      res.json({ 
        status: botStatus, 
        timestamp: new Date().toISOString(),
        message: 'Bot not running'
      });
    }
  });
  
  // Start bot endpoint
  app.post('/start', async (req, res) => {
    try {
      if (bot && botStatus === 'running') {
        return res.status(400).json({ error: 'Bot already running' });
      }
      
      // Create config
      const config: TradingBotConfig = {
        tradeStation: {
          baseUrl: process.env.TRADESTATION_API_URL || 'https://sim-api.tradestation.com/v3',
          streamingUrl: '',
          clientId: process.env.TRADESTATION_CLIENT_ID!,
          clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
          redirectUri: '',
          scope: 'ReadAccount MarketData',
          sandbox: process.env.TRADESTATION_SANDBOX !== 'false'
        },
        strategy: {
          spxSymbol: '$SPXW.X',
          macdFastPeriod: 12,
          macdSlowPeriod: 26,
          macdSignalPeriod: 9,
          macdThreshold: -1.0,
          profitTarget: 100.0,
          stopLossPercentage: 0.20
        },
        trading: {
          paperTrading: process.env.PAPER_TRADING !== 'false',
          maxPositions: 1,
          accountId: process.env.TRADESTATION_ACCOUNT_ID
        },
        logging: {
          level: 'info',
          file: './logs/cloud-bot.log'
        }
      };
      
      bot = new TradingBot(config);
      await bot.start();
      botStatus = 'running';
      
      // Set up periodic status logging every 10 minutes
      statusInterval = setInterval(async () => {
        if (bot && botStatus === 'running') {
          try {
            const status = await bot.getDetailedStatus();
            
            // Log comprehensive status
            logger.info('📊 === BOT STATUS UPDATE ===');
            logger.info(`⏰ Time: ${status.timestamp}`);
            logger.info(`⏱️  Uptime: ${status.uptime}`);
            logger.info(`📈 Total Trades Today: ${status.totalTrades}`);
            logger.info(`💰 Daily P&L: $${status.dailyPnL.toFixed(2)}`);
            
            if (status.currentPosition) {
              logger.info(`🎯 Current Position:`);
              logger.info(`   ${status.currentPosition.symbol} @ $${status.currentPosition.entryPrice.toFixed(2)}`);
              logger.info(`   Current: $${status.currentPosition.currentPrice?.toFixed(2) || 'N/A'}`);
              logger.info(`   Unrealized P&L: $${status.currentPosition.unrealizedPnL?.toFixed(2) || '0.00'}`);
            } else if (status.activePositions.length > 0) {
              logger.info(`🎯 Active Positions (${status.activePositions.length}):`);
              status.activePositions.forEach(pos => {
                logger.info(`   • ${pos.symbol}: ${pos.quantity} @ ${pos.side} | P&L: $${pos.unrealizedPnL?.toFixed(2) || '0.00'}`);
              });
            } else {
              logger.info('🎯 No active positions');
            }
            
            logger.info('========================');
            
            // Also log to console for Cloud Run logs
            console.log(JSON.stringify({
              type: 'STATUS_UPDATE',
              timestamp: status.timestamp,
              uptime: status.uptime,
              totalTrades: status.totalTrades,
              dailyPnL: status.dailyPnL,
              activePositions: status.activePositions.length,
              currentPosition: status.currentPosition
            }));
            
          } catch (error) {
            logger.error('Error getting bot status:', error);
          }
        }
      }, 10 * 60 * 1000); // Every 10 minutes
      
      // Log initial status immediately
      setTimeout(async () => {
        if (bot && botStatus === 'running') {
          const status = await bot.getDetailedStatus();
          logger.info('🚀 Bot started - Initial status:');
          logger.info(`   Accounts: ${status.accounts}`);
          logger.info(`   Status: ${status.status}`);
          console.log(JSON.stringify({
            type: 'BOT_STARTED',
            ...status
          }));
        }
      }, 5000); // Wait 5 seconds for initialization
      
      // Auto-stop at 4 PM ET
      const now = new Date();
      const marketClose = new Date();
      
      // Set to 4 PM ET
      const currentHour = now.getUTCHours();
      const targetUTCHour = 20; // 4 PM ET is 8 PM UTC (EDT) or 9 PM UTC (EST)
      
      marketClose.setUTCHours(targetUTCHour, 0, 0, 0);
      
      // If we're past 4 PM ET today, set for tomorrow
      if (now >= marketClose) {
        marketClose.setDate(marketClose.getDate() + 1);
      }
      
      const msUntilClose = marketClose.getTime() - now.getTime();
      const hoursUntilClose = msUntilClose / (1000 * 60 * 60);
      
      if (hoursUntilClose > 0 && hoursUntilClose < 12) {
        logger.info(`Auto-stop scheduled for ${marketClose.toISOString()} (${hoursUntilClose.toFixed(1)} hours)`);
        setTimeout(async () => {
          if (bot) {
            logger.info('Market close - stopping bot');
            
            // Clear status logging interval
            if (statusInterval) {
              clearInterval(statusInterval);
              statusInterval = null;
            }
            
            await bot.stop();
            bot = null;
            botStatus = 'stopped';
            logger.info('Bot stopped at market close');
          }
        }, msUntilClose);
      }
      
      res.json({ message: 'Bot started successfully' });
    } catch (error: any) {
      logger.error('Failed to start bot:', error);
      res.status(500).json({ error: 'Failed to start bot', details: error.message });
    }
  });
  
  // Stop bot endpoint
  app.post('/stop', async (req, res) => {
    try {
      if (!bot || botStatus !== 'running') {
        return res.status(400).json({ error: 'Bot not running' });
      }
      
      // Clear status logging interval
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
      
      await bot.stop();
      bot = null;
      botStatus = 'stopped';
      
      logger.info('🛑 Bot stopped by user request');
      res.json({ message: 'Bot stopped successfully' });
    } catch (error: any) {
      logger.error('Failed to stop bot:', error);
      res.status(500).json({ error: 'Failed to stop bot', details: error.message });
    }
  });
  
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`☁️ Cloud Run server listening on port ${PORT}`);
  });
}

// Main entry point
if (require.main === module) {
  if (isCloudRun) {
    // Cloud Run mode - start HTTP server
    startCloudServer().catch((error) => {
      console.error('💥 Fatal Cloud Run startup error:', error);
      process.exit(1);
    });
  } else {
    // Local mode - run bot directly
    runLocalBot().catch((error) => {
      console.error('💥 Fatal startup error:', error);
      process.exit(1);
    });
  }
}

export { TradingBot, TradingBotConfig };