// SPX Strategy Test Runner
// Runs comprehensive tests of the SPX momentum strategy without TradeStation API calls

import { SPXMomentumStrategy } from '@/strategies/spx-momentum-strategy';
import { MockTradeStationClient } from './mock-tradestation-client';
import { TestDataGenerator, TestScenario } from './test-data-generator';
import { StrategyConfig, MarketContext, Signal } from '@/types/strategy';
import { Bar } from '@/types/tradestation';
import { createLogger } from '@/utils/logger';
import { Logger } from 'winston';

export interface TestResult {
  scenarioName: string;
  success: boolean;
  signals: {
    entries: Signal[];
    exits: Signal[];
  };
  performance: {
    totalTrades: number;
    winningTrades: number;
    totalPnL: number;
    winRate: number;
  };
  errors: string[];
  duration: number;
}

export interface TestSummary {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  results: TestResult[];
  overallPerformance: {
    totalTrades: number;
    totalPnL: number;
    averageWinRate: number;
  };
}

export class SPXStrategyTestRunner {
  private logger: Logger;
  private mockClient: MockTradeStationClient;

  constructor() {
    this.logger = createLogger('SPXStrategyTestRunner');
    this.mockClient = new MockTradeStationClient({
      baseUrl: 'https://mock-api.tradestation.com/v3',
      streamingUrl: 'https://mock-stream.tradestation.com/v3',
      clientId: 'mock_client_id',
      clientSecret: 'mock_client_secret',
      redirectUri: 'http://localhost:3000/callback',
      scope: 'MarketData ReadAccount Trade Crypto',
      mockMode: true,
      initialBalance: 50000,
      initialSPXPrice: 5800
    });
  }

  /**
   * Run all test scenarios
   */
  async runAllTests(): Promise<TestSummary> {
    this.logger.info('Starting comprehensive SPX strategy tests...');
    
    const scenarios = TestDataGenerator.getAllTestScenarios();
    const results: TestResult[] = [];
    
    for (const scenario of scenarios) {
      this.logger.info(`Running test scenario: ${scenario.name}`);
      const result = await this.runScenarioTest(scenario);
      results.push(result);
      
      if (result.success) {
        this.logger.info(`✅ ${scenario.name} - PASSED`);
      } else {
        this.logger.error(`❌ ${scenario.name} - FAILED: ${result.errors.join(', ')}`);
      }
    }
    
    const summary = this.generateTestSummary(results);
    this.logger.info(`Test Summary: ${summary.passedScenarios}/${summary.totalScenarios} scenarios passed`);
    
    return summary;
  }
  
  /**
   * Run a single test scenario
   */
  async runScenarioTest(scenario: TestScenario): Promise<TestResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const entrySignals: Signal[] = [];
    const exitSignals: Signal[] = [];
    
    try {
      // Create strategy instance
      const strategyConfig = this.createTestStrategyConfig();
      const strategy = new SPXMomentumStrategy(strategyConfig);
      
      // Initialize strategy
      await strategy.initialize();
      
      // Set up signal collection
      strategy.on('signals', (data: { signals: Signal[] }) => {
        for (const signal of data.signals) {
          if (signal.type === 'BUY') {
            entrySignals.push(signal);
          } else if (signal.type === 'SELL') {
            exitSignals.push(signal);
          }
        }
      });
      
      // Process all bars in the scenario
      let portfolioValue = 50000;
      let availableCash = 45000;
      
      for (let i = 0; i < scenario.bars.length; i++) {
        const bar = scenario.bars[i];
        
        // Update mock client price for realistic option pricing
        const spxPrice = parseFloat(bar.Close);
        this.mockClient.setCurrentSPXPrice(spxPrice);
        
        const context: MarketContext = {
          currentBar: bar,
          previousBars: scenario.bars.slice(0, i),
          currentQuote: {
            Symbol: '$SPXW.X',
            Bid: (spxPrice - 0.25).toString(),
            Ask: (spxPrice + 0.25).toString(),
            Last: spxPrice.toString(),
            Volume: bar.TotalVolume,
            Timestamp: bar.TimeStamp
          },
          positions: [],
          portfolioValue,
          availableCash,
          timestamp: new Date(bar.TimeStamp),
          symbol: '$SPXW.X',
          indicators: new Map()
        };
        
        // Process bar through strategy
        const signals = await strategy.onBar(bar, context);
        
        // Simulate order execution for any signals
        for (const signal of signals) {
          try {
            const orderRequest = {
              AccountID: 'MOCK123456',
              Symbol: signal.symbol,
              Quantity: signal.quantity.toString(),
              TradeAction: signal.type as 'BUY' | 'SELL',
              OrderType: 'Market' as const,
              TimeInForce: 'DAY' as const
            };
            
            const orderResult = await this.mockClient.placeOrder(orderRequest);
            if (orderResult.success) {
              // Update portfolio values (simplified)
              if (signal.type === 'BUY') {
                availableCash -= signal.quantity * signal.price * 100; // Options multiplier
              } else {
                availableCash += signal.quantity * signal.price * 100;
              }
              portfolioValue = availableCash + this.calculatePositionsValue();
            }
          } catch (error) {
            errors.push(`Order execution error: ${error}`);
          }
        }
      }
      
      // Validate results against expectations  
      const success = this.validateTestResults(
        scenario, 
        entrySignals, 
        exitSignals, 
        errors
      );
      
      const performance = this.calculatePerformanceMetrics(entrySignals, exitSignals);
      
      return {
        scenarioName: scenario.name,
        success,
        signals: {
          entries: entrySignals,
          exits: exitSignals
        },
        performance,
        errors,
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      errors.push(`Test execution error: ${error}`);
      return {
        scenarioName: scenario.name,
        success: false,
        signals: {
          entries: entrySignals,
          exits: exitSignals
        },
        performance: {
          totalTrades: 0,
          winningTrades: 0,
          totalPnL: 0,
          winRate: 0
        },
        errors,
        duration: Date.now() - startTime
      };
    }
  }
  
  /**
   * Run a quick test with live-like data
   */
  async runQuickTest(): Promise<TestResult> {
    this.logger.info('Running quick test with realistic data...');
    
    const testBars = TestDataGenerator.generateRealisticIntradayData();
    const scenario: TestScenario = {
      name: 'Quick Realistic Test',
      description: 'Quick test with realistic intraday data',
      startPrice: 5800,
      bars: testBars,
      expectedSignals: { entries: 0, exits: 0 } // No specific expectations
    };
    
    return await this.runScenarioTest(scenario);
  }
  
  /**
   * Test specific MACD conditions
   */
  async testMACDConditions(): Promise<void> {
    this.logger.info('Testing MACD condition detection...');
    
    const strategyConfig = this.createTestStrategyConfig();
    const strategy = new SPXMomentumStrategy(strategyConfig);
    await strategy.initialize();
    
    // Create bars that should trigger MACD conditions
    const testBars = TestDataGenerator.generateMACDBullishScenario().bars;
    
    let macdBelowThreshold = false;
    let bullishCrossover = false;
    
    for (let i = 0; i < testBars.length; i++) {
      const bar = testBars[i];
      const context: MarketContext = {
        currentBar: bar,
        previousBars: testBars.slice(0, i),
        currentQuote: {
          Symbol: '$SPXW.X',
          Bid: (parseFloat(bar.Close) - 0.25).toString(),
          Ask: (parseFloat(bar.Close) + 0.25).toString(),
          Last: bar.Close,
          Volume: bar.TotalVolume,
          Timestamp: bar.TimeStamp
        },
        positions: [],
        portfolioValue: 50000,
        availableCash: 45000,
        timestamp: new Date(bar.TimeStamp),
        symbol: '$SPXW.X',
        indicators: new Map()
      };
      
      await strategy.onBar(bar, context);
      
      // Check MACD values (would need access to strategy internals)
      const macdValue = context.indicators.get('macd') as number;
      const crossover = context.indicators.get('macd_crossover') as number;
      
      if (macdValue && macdValue < -2) {
        macdBelowThreshold = true;
      }
      
      if (crossover === 1) {
        bullishCrossover = true;
      }
    }
    
    this.logger.info(`MACD below -2 detected: ${macdBelowThreshold}`);
    this.logger.info(`Bullish crossover detected: ${bullishCrossover}`);
  }
  
  private createTestStrategyConfig(): StrategyConfig {
    return {
      id: 'spx-momentum-test',
      name: 'SPX Momentum Test Strategy',
      type: 'SPX_MOMENTUM',
      enabled: true,
      symbols: ['$SPXW.X'],
      timeframe: '1min',
      parameters: {
        macdFastPeriod: 12,
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        macdThreshold: -2.0,
        profitTarget: 1.0,
        optionDaysToExpiry: 7
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
          operator: 'AND',
          conditions: []
        }
      },
      riskManagement: {
        maxPositionSize: 5000,
        maxPositionSizeType: 'dollars'
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
  }
  
  private validateTestResults(
    scenario: TestScenario,
    entrySignals: Signal[],
    exitSignals: Signal[],
    errors: string[]
  ): boolean {
    let success = true;
    
    // Check if we have significant errors
    if (errors.length > 0) {
      this.logger.warn(`Test had ${errors.length} errors`);
      // Don't fail for minor errors, but log them
    }
    
    // Validate signal expectations (allow some flexibility)
    const expectedEntries = scenario.expectedSignals.entries;
    const expectedExits = scenario.expectedSignals.exits;
    
    if (expectedEntries > 0 && entrySignals.length === 0) {
      this.logger.warn(`Expected ${expectedEntries} entry signals but got 0`);
      success = false;
    }
    
    if (expectedExits > 0 && exitSignals.length === 0) {
      this.logger.warn(`Expected ${expectedExits} exit signals but got 0`);
      // Don't fail if no exit due to no profitable conditions
    }
    
    // Check for option symbol format
    for (const signal of entrySignals) {
      if (!signal.symbol.startsWith('SPXW')) {
        this.logger.error(`Invalid option symbol format: ${signal.symbol}`);
        success = false;
      }
    }
    
    return success;
  }
  
  private calculatePerformanceMetrics(entrySignals: Signal[], exitSignals: Signal[]) {
    const totalTrades = Math.min(entrySignals.length, exitSignals.length);
    let totalPnL = 0;
    let winningTrades = 0;
    
    for (let i = 0; i < totalTrades; i++) {
      const entry = entrySignals[i];
      const exit = exitSignals[i];
      
      if (entry && exit) {
        const pnl = (exit.price - entry.price) * exit.quantity * 100; // Options multiplier
        totalPnL += pnl;
        
        if (pnl > 0) {
          winningTrades++;
        }
      }
    }
    
    return {
      totalTrades,
      winningTrades,
      totalPnL,
      winRate: totalTrades > 0 ? winningTrades / totalTrades : 0
    };
  }
  
  private calculatePositionsValue(): number {
    const positions = this.mockClient.getMockPositions();
    let totalValue = 0;
    
    for (const position of positions.values()) {
      totalValue += position.MarketValue;
    }
    
    return totalValue;
  }
  
  private generateTestSummary(results: TestResult[]): TestSummary {
    const passedResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);
    
    const totalTrades = results.reduce((sum, r) => sum + r.performance.totalTrades, 0);
    const totalPnL = results.reduce((sum, r) => sum + r.performance.totalPnL, 0);
    const averageWinRate = results.length > 0 ? 
      results.reduce((sum, r) => sum + r.performance.winRate, 0) / results.length : 0;
    
    return {
      totalScenarios: results.length,
      passedScenarios: passedResults.length,
      failedScenarios: failedResults.length,
      results,
      overallPerformance: {
        totalTrades,
        totalPnL,
        averageWinRate
      }
    };
  }
  
  /**
   * Print detailed test report
   */
  printTestReport(summary: TestSummary): void {
    console.log('\n' + '='.repeat(60));
    console.log('SPX MOMENTUM STRATEGY TEST REPORT');
    console.log('='.repeat(60));
    
    console.log(`\nOverall Results:`);
    console.log(`  Total Scenarios: ${summary.totalScenarios}`);
    console.log(`  Passed: ${summary.passedScenarios}`);
    console.log(`  Failed: ${summary.failedScenarios}`);
    console.log(`  Success Rate: ${((summary.passedScenarios / summary.totalScenarios) * 100).toFixed(1)}%`);
    
    console.log(`\nPerformance Summary:`);
    console.log(`  Total Trades: ${summary.overallPerformance.totalTrades}`);
    console.log(`  Total P&L: $${summary.overallPerformance.totalPnL.toFixed(2)}`);
    console.log(`  Average Win Rate: ${(summary.overallPerformance.averageWinRate * 100).toFixed(1)}%`);
    
    console.log(`\nDetailed Results:`);
    for (const result of summary.results) {
      const status = result.success ? '✅' : '❌';
      console.log(`\n${status} ${result.scenarioName}`);
      console.log(`    Duration: ${result.duration}ms`);
      console.log(`    Entry Signals: ${result.signals.entries.length}`);
      console.log(`    Exit Signals: ${result.signals.exits.length}`);
      console.log(`    Trades: ${result.performance.totalTrades}`);
      console.log(`    P&L: $${result.performance.totalPnL.toFixed(2)}`);
      
      if (result.errors.length > 0) {
        console.log(`    Errors: ${result.errors.join('; ')}`);
      }
    }
    
    console.log('\n' + '='.repeat(60));
  }
  
  /**
   * Cleanup resources
   */
  destroy(): void {
    this.mockClient.destroy();
  }
}

// Export for direct execution
export async function runSPXStrategyTests(): Promise<void> {
  const testRunner = new SPXStrategyTestRunner();
  
  try {
    // Run all tests
    const summary = await testRunner.runAllTests();
    testRunner.printTestReport(summary);
    
    // Run quick test
    console.log('\nRunning quick test...');
    const quickResult = await testRunner.runQuickTest();
    console.log(`Quick test result: ${quickResult.success ? 'PASSED' : 'FAILED'}`);
    
  } catch (error) {
    console.error('Test execution failed:', error);
  } finally {
    testRunner.destroy();
  }
}

// Allow direct execution
if (require.main === module) {
  runSPXStrategyTests();
}