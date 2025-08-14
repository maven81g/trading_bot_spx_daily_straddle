#!/usr/bin/env node

/**
 * Trading Bot Cloud Run Service
 * HTTP wrapper around the main trading bot for Cloud Run deployment
 * Provides health checks, start/stop endpoints, and graceful shutdown
 */

import 'dotenv/config';
import express from 'express';
import { TradingBot, TradingBotConfig } from '../dist/trading-bot';
import { createLogger } from '../dist/utils/logger';

const logger = createLogger('BotService', { level: 'info' });
const app = express();
const PORT = process.env.PORT || 8080;

// Global bot instance
let tradingBot: TradingBot | null = null;
let botStartTime: Date | null = null;
let shutdownTimer: NodeJS.Timeout | null = null;

// Middleware
app.use(express.json());
app.use(express.text());

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    userAgent: req.get('User-Agent'),
    ip: req.ip
  });
  next();
});

/**
 * Create bot configuration (same as main index.ts)
 */
function createBotConfig(): TradingBotConfig {
  // Validate environment variables
  const requiredEnvVars = ['TRADESTATION_CLIENT_ID', 'TRADESTATION_CLIENT_SECRET', 'TRADESTATION_REFRESH_TOKEN'];
  const missing = requiredEnvVars.filter(env => !process.env[env]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
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
      level: (process.env.LOG_LEVEL as any) || 'info',
      file: process.env.LOG_FILE || './logs/trading-bot.log'
    }
  };
}

/**
 * Calculate market close time in EST (4:00 PM)
 */
function getMarketCloseTime(): Date {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  // 4:00 PM EST (21:00 UTC during EST, 20:00 UTC during EDT)
  const closeHour = isDST(now) ? 20 : 21; // Adjust for daylight saving time
  const closeTime = new Date(today.getTime() + closeHour * 60 * 60 * 1000);
  
  return closeTime;
}

/**
 * Check if date is during daylight saving time
 */
function isDST(date: Date): boolean {
  const january = new Date(date.getFullYear(), 0, 1);
  const july = new Date(date.getFullYear(), 6, 1);
  const stdTimezoneOffset = Math.max(january.getTimezoneOffset(), july.getTimezoneOffset());
  return date.getTimezoneOffset() < stdTimezoneOffset;
}

/**
 * Schedule automatic shutdown at market close (4:00 PM EST)
 */
function scheduleMarketCloseShutdown() {
  const marketCloseTime = getMarketCloseTime();
  const now = new Date();
  const msUntilClose = marketCloseTime.getTime() - now.getTime();
  
  if (msUntilClose > 0) {
    logger.info(`Scheduling automatic shutdown at market close: ${marketCloseTime.toISOString()}`);
    shutdownTimer = setTimeout(async () => {
      logger.info('Market closed - initiating automatic bot shutdown');
      await stopBot('Market closed (4:00 PM EST)');
    }, msUntilClose);
  } else {
    logger.warn('Market close time has passed - bot should shut down immediately');
  }
}

/**
 * Start the trading bot
 */
async function startBot(reason: string = 'Manual start'): Promise<boolean> {
  if (tradingBot) {
    logger.warn('Bot is already running');
    return false;
  }

  try {
    logger.info(`Starting trading bot: ${reason}`);
    const config = createBotConfig();
    tradingBot = new TradingBot(config);
    botStartTime = new Date();

    // Setup bot event listeners
    tradingBot.on('started', (state) => {
      logger.info('Trading Bot started successfully', {
        status: state.status,
        accounts: state.accounts.length,
        strategies: state.activeStrategies.size
      });
    });

    tradingBot.on('stopped', (state) => {
      logger.info('Trading Bot stopped', {
        totalPnL: state.totalPnL,
        dailyPnL: state.dailyPnL
      });
      tradingBot = null;
      botStartTime = null;
      
      // Clear shutdown timer if bot stopped manually
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
    });

    tradingBot.on('error', (error) => {
      logger.error('Trading Bot error', { error: error.message, stack: error.stack });
    });

    tradingBot.on('riskViolation', (violation) => {
      logger.warn('Risk violation detected', violation);
    });

    // Start the bot
    await tradingBot.start();

    // Schedule automatic shutdown at market close
    scheduleMarketCloseShutdown();

    // Enable demo mode if configured
    if (process.env.DEMO_MODE === 'true') {
      logger.info('Demo mode enabled - starting simulation');
      // Note: Demo mode implementation would need to be adapted from main index.ts
    }

    return true;
  } catch (error) {
    logger.error('Failed to start trading bot', { error: error instanceof Error ? error.message : String(error) });
    tradingBot = null;
    botStartTime = null;
    return false;
  }
}

/**
 * Stop the trading bot
 */
async function stopBot(reason: string = 'Manual stop'): Promise<boolean> {
  if (!tradingBot) {
    logger.warn('Bot is not running');
    return false;
  }

  try {
    logger.info(`Stopping trading bot: ${reason}`);
    await tradingBot.stop();
    
    // Clear shutdown timer
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    
    return true;
  } catch (error) {
    logger.error('Failed to stop trading bot', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  const isRunning = tradingBot !== null;
  const uptime = botStartTime ? Date.now() - botStartTime.getTime() : 0;
  
  const health = {
    status: isRunning ? 'healthy' : 'stopped',
    uptime: Math.floor(uptime / 1000), // seconds
    startTime: botStartTime?.toISOString(),
    marketCloseTime: getMarketCloseTime().toISOString(),
    environment: {
      nodeVersion: process.version,
      port: PORT,
      paperTrading: process.env.PAPER_TRADING !== 'false',
      demoMode: process.env.DEMO_MODE === 'true'
    },
    bot: isRunning ? {
      // Add bot-specific status here if needed
      // status: tradingBot.getState().status,
      // positions: tradingBot.getState().positions.size,
      // etc.
    } : null
  };

  res.status(isRunning ? 200 : 503).json(health);
});

// Start endpoint (called by Cloud Scheduler)
app.post('/start', async (req, res) => {
  const reason = req.body?.reason || 'Cloud Scheduler trigger';
  const success = await startBot(reason);
  
  if (success) {
    res.status(200).json({ 
      message: 'Trading bot started successfully',
      startTime: botStartTime?.toISOString(),
      reason 
    });
  } else {
    res.status(400).json({ 
      error: 'Failed to start trading bot (may already be running)',
      isRunning: tradingBot !== null 
    });
  }
});

// Stop endpoint
app.post('/stop', async (req, res) => {
  const reason = req.body?.reason || 'Manual stop via API';
  const success = await stopBot(reason);
  
  if (success) {
    res.status(200).json({ 
      message: 'Trading bot stopped successfully',
      reason 
    });
  } else {
    res.status(400).json({ 
      error: 'Failed to stop trading bot (may not be running)',
      isRunning: tradingBot !== null 
    });
  }
});

// Status endpoint
app.get('/status', (req, res) => {
  const isRunning = tradingBot !== null;
  const uptime = botStartTime ? Date.now() - botStartTime.getTime() : 0;
  
  res.json({
    running: isRunning,
    startTime: botStartTime?.toISOString(),
    uptime: Math.floor(uptime / 1000),
    marketCloseTime: getMarketCloseTime().toISOString(),
    scheduledShutdown: shutdownTimer !== null
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Trading Bot Cloud Run Service',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      start: 'POST /start',
      stop: 'POST /stop',
      status: 'GET /status'
    }
  });
});

// Graceful shutdown handling
async function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal} - initiating graceful shutdown`);
  
  if (tradingBot) {
    await stopBot(`Process termination (${signal})`);
  }
  
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
  }
  
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start HTTP server
app.listen(PORT, () => {
  logger.info(`Trading Bot Service listening on port ${PORT}`);
  console.log(`🚀 Trading Bot Service running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🎯 Ready for Cloud Scheduler triggers`);
});

export { app, startBot, stopBot };