#!/usr/bin/env node

import 'dotenv/config';
import { SPXStraddleBot, StraddleBotConfig } from './spx-straddle-bot';
import { createLogger } from './utils/logger';
import { StateManager, BotState } from './utils/state-manager';
import { SimpleMailgunService, NotificationLevel } from './utils/simple-mailgun-service';
import * as fs from 'fs';
import express from 'express';

const logger = createLogger('StraddleIndex', { level: 'info' });
const isCloudRun = process.env.RUNNING_IN_CLOUD === 'true';

async function runLocalBot() {
  try {
    console.log('🎯 SPX Straddle Trading Bot');
    console.log('===========================');
    console.log('Strategy: SPX ATM Straddle with Dynamic Exit\n');

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
    const config: StraddleBotConfig = {
      tradeStation: {
        baseUrl: process.env.TRADESTATION_API_URL || 'https://sim-api.tradestation.com/v3',
        streamingUrl: process.env.TRADESTATION_STREAMING_URL || 'https://sim-api.tradestation.com/v3/marketdata/stream',
        clientId: process.env.TRADESTATION_CLIENT_ID!,
        clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
        redirectUri: '',
        scope: 'ReadAccount MarketData OrderPlacement',
        sandbox: process.env.TRADESTATION_SANDBOX !== 'false'
      },
      strategy: {
        spxSymbol: process.env.SPX_SYMBOL || '$SPXW.X',
        entryTime: process.env.ENTRY_TIME || '13:46',
        targetProfitPercent: parseFloat(process.env.TARGET_PROFIT || '20'),
        stopLossPercent: process.env.STOP_LOSS ? parseFloat(process.env.STOP_LOSS) : undefined,
        exitTime: process.env.EXIT_TIME || '15:50'
      },
      trading: {
        paperTrading: process.env.PAPER_TRADING !== 'false',
        maxPositionValue: parseFloat(process.env.MAX_POSITION_VALUE || '10000'),
        accountId: process.env.TRADESTATION_ACCOUNT_ID,
        contractMultiplier: 100
      },
      logging: {
        level: process.env.TESTING === 'true' ? 'debug' : (process.env.LOG_LEVEL as any) || 'info',
        file: process.env.LOG_FILE || './logs/straddle-bot.log'
      },
      bigquery: process.env.GOOGLE_CLOUD_PROJECT ? {
        projectId: process.env.GOOGLE_CLOUD_PROJECT,
        datasetId: process.env.BIGQUERY_DATASET || 'spx_straddle'
      } : undefined,
      heartbeat: {
        enabled: true,
        intervalMs: 300000, // 5 minutes
        webhookUrl: process.env.HEARTBEAT_WEBHOOK_URL,
        logPath: './logs/heartbeat.log'
      }
    };

    // Initialize state manager and notifications
    const stateManager = new StateManager('./data/bot-state.json', logger);
    const mailgunConfig = {
      enabled: !!process.env.MAILGUN_API_KEY,
      apiKey: process.env.MAILGUN_API_KEY || '',
      domain: process.env.MAILGUN_DOMAIN || '',
      from: process.env.MAILGUN_FROM || 'noreply@yourdomain.com',
      to: process.env.MAILGUN_TO?.split(',') || []
    };
    
    const notificationService = new SimpleMailgunService(mailgunConfig, logger);

    console.log('📊 Configuration:');
    console.log(`   API: ${config.tradeStation.sandbox ? 'Sandbox' : 'Production'}`);
    console.log(`   Paper Trading: ${config.trading.paperTrading ? '✅ YES (SAFE)' : '❌ NO (REAL MONEY)'}`);
    console.log(`   Entry Time: ${config.strategy.entryTime} ET`);
    console.log(`   Target Profit: ${config.strategy.targetProfitPercent}%`);
    console.log(`   Stop Loss: ${config.strategy.stopLossPercent ? config.strategy.stopLossPercent + '%' : 'None (hold to EOD)'}`);
    console.log(`   Exit Time: ${config.strategy.exitTime} ET`);
    console.log(`   Max Position: $${config.trading.maxPositionValue}`);
    console.log(`   Notifications: ${mailgunConfig.enabled ? '✅ Mailgun' : '❌ None'}`);
    console.log('');

    // Create directories
    const logDir = './logs';
    const dataDir = './data';
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initialize state manager
    let savedState: BotState | null = null;
    try {
      savedState = await stateManager.initialize();
      if (savedState) {
        console.log(`📁 Restored state: Daily P&L: $${savedState.dailyPnL}, Trades: ${savedState.totalTrades}`);
      }
    } catch (error) {
      logger.warn('Could not load saved state:', error);
    }

    // Create bot instance
    const bot = new SPXStraddleBot(config);
    
    // Restore state if available
    if (savedState) {
      logger.info('State restoration capability added but requires bot implementation');
    }
    
    // Start auto-save for state
    stateManager.startAutoSave(30000); // Every 30 seconds

    // Setup enhanced signal handlers
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
      
      // Create final state snapshot
      try {
        const finalStatus = await bot.getDetailedStatus();
        const finalState: BotState = {
          version: '1.0',
          lastSaved: new Date().toISOString(),
          dailyPnL: finalStatus.dailyPnL,
          totalTrades: finalStatus.totalTrades,
          currentPosition: finalStatus.currentPosition ? {
            entryTime: finalStatus.currentPosition.entryTime,
            spxPrice: 0,
            strike: parseInt(finalStatus.currentPosition.symbol.split(' ')[1]),
            callSymbol: '',
            putSymbol: '',
            callEntryPrice: 0,
            putEntryPrice: 0,
            totalEntryPrice: finalStatus.currentPosition.entryPrice,
            quantity: finalStatus.currentPosition.quantity || 1,
            targetPrice: finalStatus.currentPosition.targetPrice || 0,
            stopPrice: finalStatus.currentPosition.stopPrice,
            isOpen: true
          } : undefined,
          closedPositions: []
        };
        await stateManager.save(finalState);
        await stateManager.createSnapshot(`shutdown_${signal.toLowerCase()}`);
      } catch (error) {
        logger.error('Failed to save final state:', error);
      }
      
      stateManager.stopAutoSave();
      await bot.stop();
      
      await notificationService.sendCriticalAlert(
        'Bot Shutdown',
        `SPX Straddle Bot shut down via ${signal}`,
        { timestamp: new Date().toISOString() }
      );
      
      process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Event listeners
    bot.on('started', () => {
      console.log('✅ Straddle Bot started successfully!');
      console.log('🔄 Bot is running... Press Ctrl+C to stop.\n');
    });

    bot.on('stopped', () => {
      console.log('\n🛑 Straddle Bot stopped');
    });

    bot.on('error', (error) => {
      console.error('❌ Straddle Bot error:', error instanceof Error ? error.message : String(error));
      logger.error('Bot error:', error);
    });

    bot.on('straddleOpened', async (position) => {
      console.log(`📈 Straddle opened: ${position.strike} strike`);
      console.log(`   Entry: $${position.totalEntryPrice.toFixed(2)} (Call: $${position.callEntryPrice.toFixed(2)}, Put: $${position.putEntryPrice.toFixed(2)})`);
      console.log(`   Target: $${position.targetPrice.toFixed(2)}`);
      if (position.stopPrice) {
        console.log(`   Stop: $${position.stopPrice.toFixed(2)}`);
      }
      
      // Save state update
      try {
        const status = await bot.getDetailedStatus();
        await stateManager.save({
          version: '1.0',
          lastSaved: new Date().toISOString(),
          dailyPnL: status.dailyPnL,
          totalTrades: status.totalTrades,
          closedPositions: [],
          currentPosition: {
            entryTime: position.entryTime.toISOString(),
            spxPrice: position.spxPrice,
            strike: position.strike,
            callSymbol: position.callSymbol,
            putSymbol: position.putSymbol,
            callEntryPrice: position.callEntryPrice,
            putEntryPrice: position.putEntryPrice,
            totalEntryPrice: position.totalEntryPrice,
            quantity: position.quantity,
            targetPrice: position.targetPrice,
            stopPrice: position.stopPrice,
            isOpen: position.isOpen
          }
        });
      } catch (error) {
        logger.error('Failed to save state after position open:', error);
      }
      
      // Send notification
      try {
        await notificationService.sendTradeOpened(position);
      } catch (error) {
        logger.error('Failed to send trade opened notification:', error);
      }
    });

    bot.on('straddleClosed', async (position) => {
      const pnlPercent = position.pnl ? (position.pnl / (position.totalEntryPrice * position.quantity * 100)) * 100 : 0;
      console.log(`📉 Straddle closed: ${position.strike} strike`);
      console.log(`   Exit Reason: ${position.exitReason}`);
      console.log(`   P&L: $${position.pnl?.toFixed(2)} (${pnlPercent.toFixed(1)}%)`);
      
      // Save state update
      try {
        const status = await bot.getDetailedStatus();
        await stateManager.save({
          version: '1.0',
          lastSaved: new Date().toISOString(),
          dailyPnL: status.dailyPnL,
          totalTrades: status.totalTrades,
          closedPositions: [],
          currentPosition: undefined
        });
      } catch (error) {
        logger.error('Failed to save state after position close:', error);
      }
      
      // Send notification
      try {
        await notificationService.sendTradeClosed(position);
      } catch (error) {
        logger.error('Failed to send trade closed notification:', error);
      }
    });
    
    bot.on('heartbeatAlert', async (message: string) => {
      try {
        await notificationService.sendCriticalAlert('System Alert', message);
      } catch (error) {
        logger.error('Failed to send heartbeat alert:', error);
      }
    });
    
    bot.on('error', async (error) => {
      console.error('❌ Straddle Bot error:', error instanceof Error ? error.message : String(error));
      logger.error('Bot error:', error);
      
      try {
        await notificationService.sendCriticalAlert(
          'Bot Error',
          error instanceof Error ? error.message : String(error),
          { stack: error instanceof Error ? error.stack : undefined }
        );
      } catch (notificationError) {
        logger.error('Failed to send error notification:', notificationError);
      }
    });

    // Start the bot
    await bot.start();

    // Send startup notification
    try {
      await notificationService.sendStartupNotification({
        paperTrading: config.trading.paperTrading,
        entryTime: config.strategy.entryTime,
        targetProfit: config.strategy.targetProfitPercent,
        stopLoss: config.strategy.stopLossPercent,
        maxPosition: config.trading.maxPositionValue
      });
    } catch (error) {
      logger.error('Failed to send startup notification:', error);
    }

    // Add periodic dashboard-style status logging
    console.log('\n📊 Dashboard mode enabled - Status updates every 2 minutes');
    
    setInterval(async () => {
      try {
        const status = await bot.getDetailedStatus();
        
        console.log('\n╔══════════════════════════════════════════════════════════════╗');
        console.log('║                  🎯 STRADDLE BOT STATUS                       ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log(`║ ⏰ Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET | Uptime: ${status.uptime.padEnd(20)}║`);
        console.log(`║ 📈 Trades: ${status.totalTrades.toString().padEnd(3)} | Daily P&L: $${status.dailyPnL.toFixed(2).padEnd(10)}            ║`);
        console.log('╠══════════════════════════════════════════════════════════════╣');
        
        if (status.currentPosition) {
          console.log('║ 🎯 ACTIVE STRADDLE:                                          ║');
          console.log(`║   Strike: ${status.currentPosition.symbol.padEnd(20)}                        ║`);
          console.log(`║   Entry: $${status.currentPosition.entryPrice.toFixed(2)} | Current: $${(status.currentPosition.currentPrice || 0).toFixed(2)}                    ║`);
          console.log(`║   P&L: $${(status.currentPosition.unrealizedPnL || 0).toFixed(2)} (${((status.currentPosition.unrealizedPnL || 0) / (status.currentPosition.entryPrice * 100) * 100).toFixed(1)}%)                                   ║`);
          const holdTime = Math.floor((Date.now() - new Date(status.currentPosition.entryTime).getTime()) / 60000);
          console.log(`║   Hold Time: ${holdTime} minutes                                      ║`);
        } else {
          console.log('║ 🎯 No active straddle - Waiting for entry time...            ║');
        }
        
        console.log('╚══════════════════════════════════════════════════════════════╝\n');
      } catch (error) {
        console.error('Error getting status:', error);
      }
    }, 2 * 60 * 1000); // Every 2 minutes

    // Keep the process alive
    setInterval(() => {
      // Heartbeat
    }, 30000);

  } catch (error) {
    console.error('💥 Failed to start Straddle Bot:', error instanceof Error ? error.message : String(error));
    logger.error('Startup error:', error);
    process.exit(1);
  }
}

// Cloud Run HTTP Server Mode
async function startCloudServer() {
  const app = express();
  app.use(express.json());
  
  let bot: SPXStraddleBot | null = null;
  let botStatus = 'stopped';
  let statusInterval: NodeJS.Timeout | null = null;
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });
  
  // Status endpoint
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
      
      // Create config from environment
      const config: StraddleBotConfig = {
        tradeStation: {
          baseUrl: process.env.TRADESTATION_API_URL || 'https://api.tradestation.com/v3',
          streamingUrl: process.env.TRADESTATION_STREAMING_URL || 'https://api.tradestation.com/v3/marketdata/stream',
          clientId: process.env.TRADESTATION_CLIENT_ID!,
          clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
          redirectUri: '',
          scope: 'ReadAccount MarketData OrderPlacement',
          sandbox: process.env.TRADESTATION_SANDBOX !== 'false'
        },
        strategy: {
          spxSymbol: process.env.SPX_SYMBOL || '$SPXW.X',
          entryTime: process.env.ENTRY_TIME || '13:46',
          targetProfitPercent: parseFloat(process.env.TARGET_PROFIT || '20'),
          stopLossPercent: process.env.STOP_LOSS ? parseFloat(process.env.STOP_LOSS) : undefined,
          exitTime: process.env.EXIT_TIME || '15:50'
        },
        trading: {
          paperTrading: process.env.PAPER_TRADING !== 'false',
          maxPositionValue: parseFloat(process.env.MAX_POSITION_VALUE || '10000'),
          accountId: process.env.TRADESTATION_ACCOUNT_ID,
          contractMultiplier: 100
        },
        logging: {
          level: 'info',
          file: './logs/cloud-straddle.log'
        },
        bigquery: process.env.GOOGLE_CLOUD_PROJECT ? {
          projectId: process.env.GOOGLE_CLOUD_PROJECT,
          datasetId: process.env.BIGQUERY_DATASET || 'spx_straddle'
        } : undefined
      };
      
      bot = new SPXStraddleBot(config);
      await bot.start();
      botStatus = 'running';
      
      // Set up periodic status logging every 10 minutes
      statusInterval = setInterval(async () => {
        if (bot && botStatus === 'running') {
          try {
            const status = await bot.getDetailedStatus();
            
            logger.info('🎯 === STRADDLE BOT STATUS ===');
            logger.info(`⏰ Time: ${status.timestamp}`);
            logger.info(`⏱️  Uptime: ${status.uptime}`);
            logger.info(`📈 Total Trades: ${status.totalTrades}`);
            logger.info(`💰 Daily P&L: $${status.dailyPnL.toFixed(2)}`);
            
            if (status.currentPosition) {
              logger.info(`🎯 Active Straddle:`);
              logger.info(`   ${status.currentPosition.symbol}`);
              logger.info(`   Entry: $${status.currentPosition.entryPrice.toFixed(2)}`);
              logger.info(`   Current: $${status.currentPosition.currentPrice?.toFixed(2) || 'N/A'}`);
              logger.info(`   Unrealized P&L: $${status.currentPosition.unrealizedPnL?.toFixed(2) || '0.00'}`);
            } else {
              logger.info('🎯 No active straddle');
            }
            
            logger.info('============================');
            
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
      
      // Auto-stop at market close
      const now = new Date();
      const marketClose = new Date();
      const targetUTCHour = 20; // 4 PM ET
      
      marketClose.setUTCHours(targetUTCHour, 0, 0, 0);
      
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
      
      res.json({ message: 'Straddle bot started successfully' });
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
    console.log(`🎯 Straddle Bot ready for deployment`);
  });
}

// Main entry point
if (require.main === module) {
  if (isCloudRun) {
    // Cloud Run mode
    startCloudServer().catch((error) => {
      console.error('💥 Fatal Cloud Run startup error:', error);
      process.exit(1);
    });
  } else {
    // Local mode
    runLocalBot().catch((error) => {
      console.error('💥 Fatal startup error:', error);
      process.exit(1);
    });
  }
}

export { SPXStraddleBot, StraddleBotConfig };