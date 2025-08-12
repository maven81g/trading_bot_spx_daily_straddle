#!/usr/bin/env node

// Simple Trading Bot Index - For Quick Testing
// Supports both local execution and Cloud Run HTTP mode

import 'dotenv/config';
import { SimpleBot, SimpleBotConfig } from './simple-bot';
import { createLogger } from './utils/logger';
import * as fs from 'fs';
import express from 'express';

const logger = createLogger('SimpleBotIndex', { level: 'info' });
const isCloudRun = process.env.RUNNING_IN_CLOUD === 'true';

async function main() {
  try {
    console.log('🚀 Starting Simple SPX Trading Bot for Testing...');
    console.log('================================================\n');

    // Validate environment variables
    const requiredEnvVars = ['TRADESTATION_CLIENT_ID', 'TRADESTATION_CLIENT_SECRET', 'TRADESTATION_REFRESH_TOKEN'];
    const missing = requiredEnvVars.filter(env => !process.env[env]);
    
    if (missing.length > 0) {
      console.error('❌ Missing required environment variables:');
      missing.forEach(env => console.error(`   - ${env}`));
      console.error('\n💡 Copy env.example to .env and fill in your TradeStation credentials');
      process.exit(1);
    }

    // Create simple bot configuration
    const config: SimpleBotConfig = {
      tradeStation: {
        baseUrl: 'https://sim-api.tradestation.com/v3',
        clientId: process.env.TRADESTATION_CLIENT_ID!,
        clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
        redirectUri: '',
        scope: 'ReadAccount',
        sandbox: true
      },
      logging: {
        level: (process.env.LOG_LEVEL as any) || 'info',
        file: process.env.LOG_FILE || './logs/simple-bot.log'
      }
    };

    console.log('📊 Simple Bot Configuration:');
    console.log(`   Mode: Testing/Development`);
    console.log(`   API: ${config.tradeStation.sandbox ? 'Sandbox' : 'Production'}`);
    console.log(`   Log Level: ${config.logging.level}`);
    console.log('');

    // Create logs directory if needed
    const logDir = './logs';
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Create bot instance
    const bot = new SimpleBot(config);

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
      logger.error('💥 Uncaught Exception:', error);
      console.error('💥 Uncaught Exception:', error.message);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('💥 Unhandled Rejection:', reason);
      console.error('💥 Unhandled Rejection:', reason);
      process.exit(1);
    });

    // Event listeners
    bot.on('started', () => {
      console.log('✅ Simple Trading Bot started successfully!');
      console.log('🔄 Bot is running... Press Ctrl+C to stop.\n');
    });

    bot.on('stopped', () => {
      console.log('\n🛑 Simple Trading Bot stopped');
    });

    bot.on('error', (error) => {
      console.error('❌ Simple Trading Bot error:', error instanceof Error ? error.message : String(error));
      logger.error('Bot error:', error);
    });

    // Start the bot
    await bot.start();

    // Keep the process alive
    setInterval(() => {
      // Heartbeat
    }, 30000);

  } catch (error) {
    console.error('💥 Failed to start Simple Trading Bot:', error instanceof Error ? error.message : String(error));
    logger.error('Startup error:', error);
    process.exit(1);
  }
}

// Export for testing
export { main };

// Cloud Run HTTP Server Mode
async function startCloudServer() {
  const app = express();
  app.use(express.json());
  
  let bot: SimpleBot | null = null;
  let botStatus = 'stopped';
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });
  
  // Status endpoint
  app.get('/status', (req, res) => {
    res.json({ botStatus, timestamp: new Date().toISOString() });
  });
  
  // Start bot endpoint
  app.post('/start', async (req, res) => {
    try {
      if (bot && botStatus === 'running') {
        return res.status(400).json({ error: 'Bot already running' });
      }
      
      // Create config
      const config: SimpleBotConfig = {
        tradeStation: {
          baseUrl: 'https://sim-api.tradestation.com/v3',
          clientId: process.env.TRADESTATION_CLIENT_ID!,
          clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
          redirectUri: '',
          scope: 'ReadAccount',
          sandbox: true
        },
        logging: {
          level: 'warn', // Minimal logging in cloud
          file: './logs/cloud-bot.log'
        }
      };
      
      bot = new SimpleBot(config);
      await bot.start();
      botStatus = 'running';
      
      // Auto-stop at 4 PM ET
      const now = new Date();
      const marketClose = new Date();
      marketClose.setHours(16, 0, 0, 0);
      
      if (now < marketClose) {
        const msUntilClose = marketClose.getTime() - now.getTime();
        setTimeout(async () => {
          if (bot) {
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
      
      await bot.stop();
      bot = null;
      botStatus = 'stopped';
      
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

// Run if this file is executed directly  
if (require.main === module) {
  if (isCloudRun) {
    // Cloud Run mode - start HTTP server
    startCloudServer().catch((error) => {
      console.error('💥 Fatal Cloud Run startup error:', error);
      process.exit(1);
    });
  } else {
    // Local mode - run bot directly
    main().catch((error) => {
      console.error('💥 Fatal startup error:', error);
      process.exit(1);
    });
  }
}