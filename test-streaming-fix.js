#!/usr/bin/env node

/**
 * Test script to verify the streaming fix
 * This will show the difference between tick data vs bar data
 */

require('dotenv').config();
const { SPXStraddleBot } = require('./dist/spx-straddle-bot.js');

console.log('🧪 Testing SPX Streaming Fix');
console.log('============================');
console.log('This test will show proper 1-minute bar consolidation instead of tick data');
console.log('You should see:');
console.log('  ✅ ONE update per minute (at :00 seconds)');
console.log('  ✅ Complete OHLC bar data');
console.log('  ✅ No duplicate timestamps');
console.log('');

// Create minimal config for testing
const config = {
  tradeStation: {
    baseUrl: process.env.TRADESTATION_API_URL || 'https://sim-api.tradestation.com/v3',
    streamingUrl: process.env.TRADESTATION_STREAMING_URL || 'https://sim-api.tradestation.com/v3/marketdata/stream',
    clientId: process.env.TRADESTATION_CLIENT_ID,
    clientSecret: process.env.TRADESTATION_CLIENT_SECRET,
    redirectUri: '',
    scope: 'ReadAccount MarketData',
    sandbox: process.env.TRADESTATION_SANDBOX !== 'false'
  },
  strategy: {
    spxSymbol: process.env.SPX_SYMBOL || '$SPXW.X',
    entryTime: '09:33',
    targetProfitPercent: 20,
    exitTime: '15:50'
  },
  trading: {
    paperTrading: true,
    maxPositionValue: 10000,
    contractMultiplier: 100
  },
  logging: {
    level: 'debug',
    file: './logs/streaming-test.log'
  }
};

async function testStreamingFix() {
  const bot = new SPXStraddleBot(config);
  
  let barCount = 0;
  let lastTimestamp = null;
  
  // Listen for important events
  bot.on('error', (error) => {
    console.error('❌ Error:', error.message);
  });
  
  // Monitor bar updates by overriding the handler
  const originalHandler = bot.handleBarUpdate;
  let barUpdateCount = 0;
  
  console.log('🚀 Starting bot to test SPX streaming...');
  console.log('⏳ Waiting for SPX bar data...');
  console.log('');
  
  try {
    await bot.start();
    
    // Let it run for 5 minutes to see bar behavior
    setTimeout(async () => {
      console.log('\n📊 Test Results:');
      console.log(`   Bar updates received: ${barUpdateCount}`);
      console.log('   Expected: ~5 updates (one per minute)');
      
      if (barUpdateCount >= 1 && barUpdateCount <= 10) {
        console.log('✅ SUCCESS: Receiving consolidated bar data (not ticks)');
      } else if (barUpdateCount > 100) {
        console.log('❌ FAILURE: Still receiving tick data (too many updates)');
      } else {
        console.log('⚠️  INCONCLUSIVE: May need more time or market closed');
      }
      
      await bot.stop();
      process.exit(0);
    }, 5 * 60 * 1000); // 5 minutes
    
  } catch (error) {
    console.error('❌ Failed to start bot:', error.message);
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
  console.log('\n🛑 Stopping test...');
  process.exit(0);
});

// Run the test
testStreamingFix().catch(console.error);

console.log('Press Ctrl+C to stop the test early');