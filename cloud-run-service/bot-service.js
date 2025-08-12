#!/usr/bin/env node

/**
 * Trading Bot Cloud Run Service
 * HTTP server wrapper for the trading bot
 */

const express = require('express');
// In Docker container, dist is at /app/dist, bot-service.js is at /app/bot-service.js
const { SimpleTradingBot } = require('./dist/simple-trading-bot');
const { createLogger } = require('./dist/utils/logger-config');  
const { tradeReporter } = require('./dist/utils/trade-reporter');

// Setup logger with cloud-specific configuration
process.env.RUNNING_IN_CLOUD = 'true';
const logger = createLogger();

const app = express();
app.use(express.json());

let bot = null;
let botStatus = 'stopped';
let lastError = null;
let startTime = null;
let marketCloseTimer = null;

// Schedule auto-stop at market close (4:00 PM ET)
function scheduleMarketClose() {
  const now = new Date();
  const marketClose = new Date();
  
  // Set to 4:00 PM today
  marketClose.setHours(16, 0, 0, 0);
  
  // If it's already past 4 PM today, don't schedule (shouldn't happen)
  if (now >= marketClose) {
    logger.info('Market already closed for today');
    return;
  }
  
  const msUntilClose = marketClose.getTime() - now.getTime();
  logger.info(`Scheduled auto-stop at market close in ${Math.round(msUntilClose / 1000 / 60)} minutes`);
  
  marketCloseTimer = setTimeout(async () => {
    try {
      logger.info('Market close - auto-stopping trading bot');
      
      if (bot) {
        await bot.stop();
        bot = null;
      }
      
      botStatus = 'stopped';
      logger.info('Trading bot stopped at market close');
      
      // Print final daily summary
      tradeReporter.printSummary();
      
    } catch (error) {
      logger.error('Error during auto-stop:', error);
    }
  }, msUntilClose);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    botStatus,
    startTime,
    uptime: startTime ? Date.now() - startTime.getTime() : 0,
    lastError,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Trading Bot Cloud Run Service',
    version: '1.0.0',
    status: botStatus,
    endpoints: {
      health: '/health',
      status: '/status',
      start: '/start (POST)',
      stop: '/stop (POST)'
    }
  });
});

// Start bot endpoint
app.post('/start', async (req, res) => {
  try {
    if (bot && botStatus === 'running') {
      return res.status(400).json({ 
        error: 'Bot is already running' 
      });
    }

    logger.info('Starting trading bot...');
    
    // Create bot configuration
    const botConfig = {
      tradeStation: {
        clientId: process.env.TRADESTATION_CLIENT_ID,
        clientSecret: process.env.TRADESTATION_CLIENT_SECRET,
        refreshToken: process.env.TRADESTATION_REFRESH_TOKEN,
        apiUrl: 'https://api.tradestation.com/v3',
        paperTrading: true
      },
      strategy: {
        spxSymbol: '$SPX.X',
        macdFastPeriod: 12,
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        macdThreshold: 0.5,
        profitTarget: 100,
        stopLossPercentage: 2
      },
      trading: {
        paperTrading: true,
        maxPositions: 1
      },
      logging: {
        level: 'info',
        console: true,
        file: false
      }
    };
    
    bot = new SimpleTradingBot(botConfig);
    await bot.start();
    
    // Start periodic reporting every 10 minutes
    tradeReporter.startPeriodicReporting(10);
    
    // Schedule auto-stop at market close
    scheduleMarketClose();
    
    botStatus = 'running';
    startTime = new Date();
    lastError = null;
    
    res.json({ 
      message: 'Bot started successfully',
      status: botStatus 
    });
  } catch (error) {
    logger.error('Failed to start bot:', error);
    lastError = error.message;
    botStatus = 'error';
    res.status(500).json({ 
      error: 'Failed to start bot',
      details: error.message 
    });
  }
});

// Stop bot endpoint
app.post('/stop', async (req, res) => {
  try {
    if (!bot || botStatus !== 'running') {
      return res.status(400).json({ 
        error: 'Bot is not running' 
      });
    }

    logger.info('Stopping trading bot...');
    await bot.stop();
    
    // Clear market close timer if it exists
    if (marketCloseTimer) {
      clearTimeout(marketCloseTimer);
      marketCloseTimer = null;
    }
    
    bot = null;
    botStatus = 'stopped';
    
    res.json({ 
      message: 'Bot stopped successfully',
      status: botStatus 
    });
  } catch (error) {
    logger.error('Failed to stop bot:', error);
    lastError = error.message;
    res.status(500).json({ 
      error: 'Failed to stop bot',
      details: error.message 
    });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  logger.info(`Trading Bot Service listening on port ${PORT}`);
  logger.info('Service ready to accept requests');
});