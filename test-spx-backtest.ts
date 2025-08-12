#!/usr/bin/env node

// Test script to verify SPX Backtest Strategy integration
// This script demonstrates how the ported backtest logic works in the main bot architecture

import 'dotenv/config';
import { SPXBacktestStrategy } from './src/strategies/spx-backtest-strategy';
import { StrategyConfig } from './src/types/strategy';
import { createLogger } from './src/utils/logger';
import { Bar } from './src/types/tradestation';

// Sample SPX bar data for testing
const sampleSPXBars: Bar[] = [
  {
    "High": "6380.00",
    "Low": "6375.00", 
    "Open": "6379.50",
    "Close": "6377.25",
    "TimeStamp": "2025-08-06T14:30:00Z",
    "TotalVolume": "1000000",
    "Epoch": Date.now(),
    "IsRealtime": false,
    "IsEndOfHistory": false,
    "BarStatus": "Open"
  },
  {
    "High": "6385.00",
    "Low": "6370.00",
    "Open": "6377.25", 
    "Close": "6380.50",
    "TimeStamp": "2025-08-06T14:31:00Z",
    "TotalVolume": "1100000",
    "Epoch": Date.now(),
    "IsRealtime": false,
    "IsEndOfHistory": false,
    "BarStatus": "Open"
  },
  {
    "High": "6385.00",
    "Low": "6378.00",
    "Open": "6380.50",
    "Close": "6382.75",
    "TimeStamp": "2025-08-06T14:32:00Z",
    "TotalVolume": "1200000", 
    "Epoch": Date.now(),
    "IsRealtime": false,
    "IsEndOfHistory": false,
    "BarStatus": "Open"
  }
];

async function testSPXBacktestStrategy() {
  const logger = createLogger('SPXBacktestTest', { level: 'info' });
  
  console.log('🧪 Testing SPX Backtest Strategy Integration');
  console.log('=============================================\n');

  try {
    // Create strategy configuration
    const config: StrategyConfig = {
      id: 'test-spx-backtest',
      name: 'Test SPX Backtest Strategy',
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
        long: {
          id: 'test-entry',
          name: 'Test Entry',
          operator: 'AND',
          conditions: []
        }
      },
      exitConditions: {
        long: {
          id: 'test-exit',
          name: 'Test Exit', 
          operator: 'OR',
          conditions: []
        }
      },
      riskManagement: {
        maxPositionSize: 5000,
        maxPositionSizeType: 'dollars',
        maxDailyLoss: 1000,
        maxDrawdown: 2000
      },
      positionSizing: {
        method: 'fixed',
        baseAmount: 1
      },
      execution: {
        orderType: 'Market',
        timeInForce: 'DAY'
      }
    };

    // Create strategy instance
    console.log('📊 Creating SPX Backtest Strategy instance...');
    const strategy = new SPXBacktestStrategy(config);
    
    // Initialize strategy
    console.log('🚀 Initializing strategy...');
    await strategy.initialize();
    
    console.log(`✅ Strategy initialized: ${strategy.getName()}`);
    console.log(`📈 Strategy enabled: ${strategy.isEnabled()}`);
    console.log(`🎯 Strategy symbols: ${strategy.getConfig().symbols.join(', ')}`);
    console.log(`⚙️  Strategy parameters:`, strategy.getConfig().parameters);
    console.log('');

    // Process sample bars
    console.log('📊 Processing sample SPX bars...');
    for (let i = 0; i < sampleSPXBars.length; i++) {
      const bar = sampleSPXBars[i];
      
      console.log(`\n📈 Processing Bar ${i + 1}:`);
      console.log(`   Time: ${bar.TimeStamp}`);
      console.log(`   OHLC: ${bar.Open}/${bar.High}/${bar.Low}/${bar.Close}`);
      
      // Create market context
      const context = {
        currentBar: bar,
        previousBars: sampleSPXBars.slice(0, i),
        currentQuote: {
          Symbol: '$SPXW.X',
          Ask: '0', AskSize: '0', Bid: '0', BidSize: '0',
          Last: bar.Close, High: bar.High, Low: bar.Low, Open: bar.Open, Close: bar.Close,
          Volume: bar.TotalVolume, NetChange: '0', NetChangePct: '0',
          PreviousClose: i > 0 ? sampleSPXBars[i-1].Close : bar.Open,
          TradeTime: bar.TimeStamp,
          MarketFlags: { IsDelayed: false, IsHalted: false, IsHardToBorrow: false, IsBats: false }
        },
        positions: [],
        portfolioValue: 100000,
        availableCash: 50000,
        timestamp: new Date(),
        symbol: '$SPXW.X',
        indicators: new Map()
      };

      // Process bar with strategy
      const signals = await strategy.onBar(bar, context);
      
      if (signals.length > 0) {
        console.log(`🚨 Signals Generated: ${signals.length}`);
        for (const signal of signals) {
          console.log(`   📈 Signal: ${signal.type} ${signal.quantity} ${signal.symbol} @ $${signal.price}`);
          console.log(`   💡 Reason: ${signal.reason}`);
          console.log(`   📊 Confidence: ${signal.confidence}`);
          console.log(`   🎯 Metadata:`, signal.metadata);
          
          // Simulate order fill for testing
          if (signal.type === 'BUY') {
            const mockOrder = {
              OrderID: `test_${Date.now()}`,
              Symbol: signal.symbol,
              Quantity: signal.quantity.toString(),
              TradeAction: 'BUY',
              FilledPrice: signal.price.toString(),
              Status: 'FLL'
            };
            
            console.log('   📋 Simulating order fill...');
            await strategy.onOrderFilled(mockOrder, context);
          }
        }
      } else {
        console.log('   ℹ️  No signals generated');
      }
      
      // Show strategy state
      const strategyState = (strategy as any).getStrategyState?.();
      if (strategyState) {
        console.log('   📊 Strategy State:', strategyState);
      }
    }

    console.log('\n✅ SPX Backtest Strategy test completed successfully!');
    console.log('\n📋 Summary:');
    console.log(`   Strategy Type: ${config.type}`);
    console.log(`   Processed Bars: ${sampleSPXBars.length}`);
    console.log(`   Configuration: Valid ✅`);
    console.log(`   Integration: Working ✅`);
    
    // Shutdown strategy
    await strategy.shutdown();
    console.log('   Shutdown: Complete ✅');

  } catch (error) {
    logger.error('❌ SPX Backtest Strategy test failed:', error);
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Export for testing
export { testSPXBacktestStrategy };

// Run if this file is executed directly
if (require.main === module) {
  testSPXBacktestStrategy().catch((error) => {
    console.error('Fatal test error:', error);
    process.exit(1);
  });
}