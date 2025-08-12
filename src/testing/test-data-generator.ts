// Test Data Generator for SPX Strategy Testing
// Generates realistic market data patterns for backtesting

import { Bar } from '@/types/tradestation';

export interface TestScenario {
  name: string;
  description: string;
  startPrice: number;
  bars: Bar[];
  expectedSignals: {
    entries: number;
    exits: number;
  };
}

export class TestDataGenerator {
  
  /**
   * Generate a MACD bullish scenario where MACD drops below -2 then crosses over
   */
  static generateMACDBullishScenario(): TestScenario {
    const startPrice = 5800;
    const bars: Bar[] = [];
    let currentPrice = startPrice;
    const baseTime = new Date('2024-01-15T09:30:00Z');
    
    // Phase 1: Downtrend to create MACD below -2 (50 bars)
    for (let i = 0; i < 50; i++) {
      const drift = -0.3; // Steady decline
      const volatility = Math.random() * 2 - 1; // Random noise
      currentPrice += drift + volatility;
      
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.5, currentPrice + 0.5));
    }
    
    // Phase 2: Consolidation phase (20 bars)
    for (let i = 50; i < 70; i++) {
      const drift = 0; // Sideways
      const volatility = Math.random() * 1 - 0.5;
      currentPrice += drift + volatility;
      
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.3, currentPrice + 0.3));
    }
    
    // Phase 3: Strong uptrend to trigger MACD crossover (30 bars)
    for (let i = 70; i < 100; i++) {
      const drift = 0.5; // Strong uptrend
      const volatility = Math.random() * 1 - 0.5;
      currentPrice += drift + volatility;
      
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.2, currentPrice + 0.8));
    }
    
    // Phase 4: Continued momentum with eventual slowdown (50 bars)
    for (let i = 100; i < 150; i++) {
      const drift = Math.max(0.1, 0.5 - (i - 100) * 0.01); // Gradually slowing momentum
      const volatility = Math.random() * 1 - 0.5;
      currentPrice += drift + volatility;
      
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.3, currentPrice + 0.3));
    }
    
    return {
      name: 'MACD Bullish Scenario',
      description: 'Downtrend creating MACD < -2, followed by strong reversal and momentum slowdown',
      startPrice,
      bars,
      expectedSignals: {
        entries: 1, // Should trigger one entry signal
        exits: 1    // Should trigger one exit signal
      }
    };
  }
  
  /**
   * Generate a false breakout scenario to test strategy robustness
   */
  static generateFalseBreakoutScenario(): TestScenario {
    const startPrice = 5850;
    const bars: Bar[] = [];
    let currentPrice = startPrice;
    const baseTime = new Date('2024-01-16T09:30:00Z');
    
    // Phase 1: Decline to get MACD below -2 (40 bars)
    for (let i = 0; i < 40; i++) {
      const drift = -0.4;
      const volatility = Math.random() * 1.5 - 0.75;
      currentPrice += drift + volatility;
      
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.5, currentPrice + 0.3));
    }
    
    // Phase 2: Brief rally (false breakout) (15 bars)
    for (let i = 40; i < 55; i++) {
      const drift = 0.6; // Quick rally
      const volatility = Math.random() * 1 - 0.5;
      currentPrice += drift + volatility;
      
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.2, currentPrice + 0.4));
    }
    
    // Phase 3: Immediate reversal back down (30 bars)
    for (let i = 55; i < 85; i++) {
      const drift = -0.5; // Sharp decline
      const volatility = Math.random() * 1 - 0.5;
      currentPrice += drift + volatility;
      
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.6, currentPrice + 0.2));
    }
    
    // Phase 4: Sideways consolidation (35 bars)
    for (let i = 85; i < 120; i++) {
      const drift = 0;
      const volatility = Math.random() * 0.8 - 0.4;
      currentPrice += drift + volatility;
      
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.3, currentPrice + 0.3));
    }
    
    return {
      name: 'False Breakout Scenario',
      description: 'MACD signals entry but immediately reverses, testing exit logic',
      startPrice,
      bars,
      expectedSignals: {
        entries: 1, // Should trigger one entry
        exits: 0    // Should not reach profitable exit
      }
    };
  }
  
  /**
   * Generate a trending scenario with multiple momentum cycles
   */
  static generateMultipleMomentumCycles(): TestScenario {
    const startPrice = 5900;
    const bars: Bar[] = [];
    let currentPrice = startPrice;
    const baseTime = new Date('2024-01-17T09:30:00Z');
    
    // Cycle 1: Down then up (80 bars)
    for (let i = 0; i < 30; i++) {
      const drift = -0.3;
      const volatility = Math.random() * 1 - 0.5;
      currentPrice += drift + volatility;
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.4, currentPrice + 0.2));
    }
    
    for (let i = 30; i < 80; i++) {
      const drift = 0.4;
      const volatility = Math.random() * 1 - 0.5;
      currentPrice += drift + volatility;
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.2, currentPrice + 0.5));
    }
    
    // Cycle 2: Consolidation then another move (80 bars)
    for (let i = 80; i < 100; i++) {
      const drift = 0;
      const volatility = Math.random() * 0.6 - 0.3;
      currentPrice += drift + volatility;
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.3, currentPrice + 0.3));
    }
    
    for (let i = 100; i < 130; i++) {
      const drift = -0.4;
      const volatility = Math.random() * 1 - 0.5;
      currentPrice += drift + volatility;
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.5, currentPrice + 0.2));
    }
    
    for (let i = 130; i < 160; i++) {
      const drift = 0.5;
      const volatility = Math.random() * 1 - 0.5;
      currentPrice += drift + volatility;
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.2, currentPrice + 0.6));
    }
    
    return {
      name: 'Multiple Momentum Cycles',
      description: 'Multiple MACD cycles to test strategy across different market conditions',
      startPrice,
      bars,
      expectedSignals: {
        entries: 2, // Should trigger two entry signals
        exits: 2    // Should trigger two exit signals
      }
    };
  }
  
  /**
   * Generate a choppy sideways market scenario
   */
  static generateChoppySidewaysScenario(): TestScenario {
    const startPrice = 5800;
    const bars: Bar[] = [];
    let currentPrice = startPrice;
    const baseTime = new Date('2024-01-18T09:30:00Z');
    
    // Create a choppy sideways market with many false signals
    for (let i = 0; i < 200; i++) {
      const cycle = Math.sin(i * 0.1) * 2; // Sine wave pattern
      const noise = Math.random() * 2 - 1; // Random noise
      const drift = cycle + noise;
      
      currentPrice += drift;
      
      // Keep price in a range
      currentPrice = Math.max(5750, Math.min(5850, currentPrice));
      
      bars.push(this.createBar(baseTime, i, currentPrice, currentPrice - 0.5, currentPrice + 0.5));
    }
    
    return {
      name: 'Choppy Sideways Market',
      description: 'Choppy sideways market to test false signal filtering',
      startPrice,
      bars,
      expectedSignals: {
        entries: 0, // Should avoid entries in choppy conditions
        exits: 0
      }
    };
  }
  
  /**
   * Generate realistic intraday SPX data with typical patterns
   */
  static generateRealisticIntradayData(date: Date = new Date()): Bar[] {
    const bars: Bar[] = [];
    let currentPrice = 5800 + (Math.random() - 0.5) * 100; // Random starting price
    
    // Generate 390 1-minute bars for a trading day (6.5 hours)
    for (let minute = 0; minute < 390; minute++) {
      const timestamp = new Date(date);
      timestamp.setHours(9, 30 + minute, 0, 0); // Start at 9:30 AM
      
      // Add intraday patterns
      const hourOfDay = timestamp.getHours() + timestamp.getMinutes() / 60;
      let volatilityMultiplier = 1;
      
      // Higher volatility at open and close
      if (hourOfDay < 10.5 || hourOfDay > 15) {
        volatilityMultiplier = 1.5;
      }
      // Lower volatility during lunch
      else if (hourOfDay > 11.5 && hourOfDay < 13.5) {
        volatilityMultiplier = 0.7;
      }
      
      const drift = (Math.random() - 0.5) * 0.3 * volatilityMultiplier;
      const volatility = Math.random() * 1.5 * volatilityMultiplier;
      
      currentPrice += drift;
      
      const high = currentPrice + Math.random() * volatility;
      const low = currentPrice - Math.random() * volatility;
      const close = currentPrice + (Math.random() - 0.5) * 0.5;
      
      bars.push({
        TimeStamp: timestamp.toISOString(),
        Open: currentPrice.toFixed(2),
        High: Math.max(currentPrice, close, high).toFixed(2),
        Low: Math.min(currentPrice, close, low).toFixed(2),
        Close: close.toFixed(2),
        TotalVolume: Math.floor(Math.random() * 2000000 + 500000).toString(),
        UpTicks: Math.floor(Math.random() * 1500),
        DownTicks: Math.floor(Math.random() * 1500),
        UpVolume: Math.floor(Math.random() * 1000000),
        DownVolume: Math.floor(Math.random() * 1000000),
        // UnchangedVolume: Math.floor(Math.random() * 100000), // Removed - not in Bar interface
        TotalTicks: Math.floor(Math.random() * 3000),
        OpenInterest: '0',
        IsRealtime: true,
        IsEndOfHistory: minute === 389,
        Epoch: timestamp.getTime(),
        BarStatus: 'Closed'
      });
      
      currentPrice = close;
    }
    
    return bars;
  }
  
  private static createBar(baseTime: Date, index: number, price: number, low: number, high: number): Bar {
    const timestamp = new Date(baseTime.getTime() + index * 60 * 1000);
    const open = price + (Math.random() - 0.5) * 0.2;
    const close = price + (Math.random() - 0.5) * 0.2;
    
    return {
      TimeStamp: timestamp.toISOString(),
      Open: open.toFixed(2),
      High: Math.max(open, close, high).toFixed(2),
      Low: Math.min(open, close, low).toFixed(2),
      Close: close.toFixed(2),
      TotalVolume: Math.floor(Math.random() * 1000000 + 100000).toString(),
      UpTicks: Math.floor(Math.random() * 1000),
      DownTicks: Math.floor(Math.random() * 1000),
      UpVolume: Math.floor(Math.random() * 500000),
      DownVolume: Math.floor(Math.random() * 500000),
      // UnchangedVolume: Math.floor(Math.random() * 50000), // Removed - not in Bar interface
      TotalTicks: Math.floor(Math.random() * 2000),
      OpenInterest: '0',
      IsRealtime: true,
      IsEndOfHistory: false,
      Epoch: timestamp.getTime(),
      BarStatus: 'Closed'
    };
  }
  
  /**
   * Get all test scenarios
   */
  static getAllTestScenarios(): TestScenario[] {
    return [
      this.generateMACDBullishScenario(),
      this.generateFalseBreakoutScenario(),
      this.generateMultipleMomentumCycles(),
      this.generateChoppySidewaysScenario()
    ];
  }
}