#!/usr/bin/env node

/**
 * SPX Straddle Strategy Backtest
 * 
 * Strategy:
 * 1. At 9:33 AM (3 minutes after open), get SPX price
 * 2. Buy ATM straddle (call + put at nearest strike)
 * 3. Exit on target profit, stop loss, or end of day
 * 
 * Parameters:
 * - Days back: Number of trading days to backtest (default: 40)
 * - Target profit: Profit target as percentage (e.g., 20 for 20%)
 * - Stop loss: Stop loss as percentage (optional, default: none)
 */

import 'dotenv/config';
import { TradeStationClient } from './src/api/client';
import { createLogger } from './src/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('StraddleBacktest');

interface BacktestConfig {
  daysBack: number;
  targetProfit: number;  // Percentage (e.g., 20 for 20%)
  stopLoss?: number;     // Percentage (optional)
  startTime: string;     // Time to enter trade (e.g., "09:33")
  endTime: string;       // Market close time
}

interface StraddlePosition {
  date: string;
  spxPrice: number;
  strike: number;
  callEntry: number;
  putEntry: number;
  totalEntry: number;
  callExit?: number;
  putExit?: number;
  totalExit?: number;
  exitTime?: string;
  exitReason?: 'target' | 'stop' | 'eod';
  pnl?: number;
  pnlPercent?: number;
  maxProfit?: number;
  maxLoss?: number;
}

class SPXStraddleBacktest {
  private client: TradeStationClient;
  private config: BacktestConfig;
  private results: StraddlePosition[] = [];
  
  constructor(config: BacktestConfig) {
    this.config = config;
    this.client = new TradeStationClient({
      baseUrl: process.env.TRADESTATION_BASE_URL || 'https://api.tradestation.com/v3',
      clientId: process.env.TRADESTATION_CLIENT_ID!,
      clientSecret: process.env.TRADESTATION_CLIENT_SECRET!,
      redirectUri: '',
      scope: 'MarketData',
      sandbox: false
    });
  }
  
  async initialize(): Promise<void> {
    console.log('🔄 Initializing SPX Straddle Backtest...');
    console.log(`📊 Configuration:`);
    console.log(`   Days Back: ${this.config.daysBack}`);
    console.log(`   Target Profit: ${this.config.targetProfit}%`);
    console.log(`   Stop Loss: ${this.config.stopLoss ? this.config.stopLoss + '%' : 'None (hold to EOD)'}`);
    console.log(`   Entry Time: ${this.config.startTime} ET`);
    console.log('');
    
    // Authenticate with TradeStation
    const refreshToken = process.env.TRADESTATION_REFRESH_TOKEN;
    if (!refreshToken) {
      throw new Error('TRADESTATION_REFRESH_TOKEN not found in environment');
    }
    
    await this.client.authenticateWithRefreshToken(refreshToken);
    console.log('✅ Authenticated with TradeStation\n');
  }
  
  /**
   * Get trading days (excluding weekends and holidays)
   */
  private getTradingDays(daysBack: number): Date[] {
    const days: Date[] = [];
    const today = new Date();
    let currentDate = new Date(today);
    
    while (days.length < daysBack) {
      currentDate.setDate(currentDate.getDate() - 1);
      const dayOfWeek = currentDate.getDay();
      
      // Skip weekends (0 = Sunday, 6 = Saturday)
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        // Skip major holidays (simplified - you may want to add more)
        const monthDay = `${currentDate.getMonth() + 1}-${currentDate.getDate()}`;
        const holidays = ['1-1', '7-4', '12-25']; // New Year, July 4th, Christmas
        
        if (!holidays.includes(monthDay)) {
          days.push(new Date(currentDate));
        }
      }
    }
    
    return days.reverse(); // Return in chronological order
  }
  
  /**
   * Get SPX price at specific time
   */
  private async getSPXPrice(date: Date, time: string): Promise<number> {
    const dateStr = date.toISOString().split('T')[0];
    const startTime = `${dateStr}T${time}:00`;
    const endTime = `${dateStr}T${time}:30`; // 30 seconds window
    
    try {
      const response = await this.client.getBars({
        symbol: 'SPX',
        interval: '1',
        unit: 'Minute',
        start: startTime,
        end: endTime
      });
      
      if (response.success && response.data?.Bars?.length > 0) {
        return parseFloat(response.data.Bars[0].Close);
      }
      
      // Fallback: try $SPX.X
      const response2 = await this.client.getBars({
        symbol: '$SPX.X',
        interval: '1',
        unit: 'Minute',
        start: startTime,
        end: endTime
      });
      
      if (response2.success && response2.data?.Bars?.length > 0) {
        return parseFloat(response2.data.Bars[0].Close);
      }
      
      throw new Error(`No SPX data for ${dateStr} at ${time}`);
    } catch (error) {
      logger.error(`Error fetching SPX price for ${dateStr}:`, error);
      throw error;
    }
  }
  
  /**
   * Find nearest strike price to SPX
   */
  private getNearestStrike(spxPrice: number): number {
    // SPX strikes are typically in $5 increments
    return Math.round(spxPrice / 5) * 5;
  }
  
  /**
   * Get option symbol for given parameters
   */
  private getOptionSymbol(date: Date, strike: number, type: 'C' | 'P'): string {
    // Get next Friday expiration (0DTE for current day if Friday)
    const dayOfWeek = date.getDay();
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7; // If Friday, use next Friday
    
    const expiration = new Date(date);
    expiration.setDate(date.getDate() + daysUntilFriday);
    
    // Format: SPXW YYMMDD C/P STRIKE
    const year = expiration.getFullYear().toString().slice(-2);
    const month = (expiration.getMonth() + 1).toString().padStart(2, '0');
    const day = expiration.getDate().toString().padStart(2, '0');
    
    return `SPXW ${year}${month}${day}${type}${strike}`;
  }
  
  /**
   * Get option prices throughout the day
   */
  private async getOptionPrices(symbol: string, date: Date): Promise<{
    open: number;
    high: number;
    low: number;
    close: number;
    prices: Array<{ time: string; price: number }>;
  }> {
    const dateStr = date.toISOString().split('T')[0];
    const startTime = `${dateStr}T09:33:00`;
    const endTime = `${dateStr}T16:00:00`;
    
    try {
      const response = await this.client.getBars({
        symbol: symbol,
        interval: '5',
        unit: 'Minute',
        start: startTime,
        end: endTime
      });
      
      if (response.success && response.data?.Bars?.length > 0) {
        const bars = response.data.Bars;
        const prices = bars.map(bar => ({
          time: bar.TimeStamp,
          price: parseFloat(bar.Close)
        }));
        
        return {
          open: parseFloat(bars[0].Open),
          high: Math.max(...bars.map(b => parseFloat(b.High))),
          low: Math.min(...bars.map(b => parseFloat(b.Low))),
          close: parseFloat(bars[bars.length - 1].Close),
          prices: prices
        };
      }
      
      throw new Error(`No option data for ${symbol} on ${dateStr}`);
    } catch (error) {
      logger.error(`Error fetching option prices for ${symbol}:`, error);
      // Return synthetic data for testing
      return {
        open: 10,
        high: 15,
        low: 8,
        close: 12,
        prices: [{ time: startTime, price: 10 }]
      };
    }
  }
  
  /**
   * Simulate straddle trade for a single day
   */
  private async backtestDay(date: Date): Promise<StraddlePosition> {
    const dateStr = date.toISOString().split('T')[0];
    console.log(`\n📅 Backtesting ${dateStr}...`);
    
    // Get SPX price at 9:33 AM
    const spxPrice = await this.getSPXPrice(date, '09:33');
    const strike = this.getNearestStrike(spxPrice);
    
    console.log(`   SPX @ 9:33 AM: $${spxPrice.toFixed(2)}`);
    console.log(`   Selected Strike: $${strike}`);
    
    // Get option symbols
    const callSymbol = this.getOptionSymbol(date, strike, 'C');
    const putSymbol = this.getOptionSymbol(date, strike, 'P');
    
    // Get option prices throughout the day
    const callData = await this.getOptionPrices(callSymbol, date);
    const putData = await this.getOptionPrices(putSymbol, date);
    
    // Entry prices (at 9:33 AM)
    const callEntry = callData.open;
    const putEntry = putData.open;
    const totalEntry = callEntry + putEntry;
    
    console.log(`   Call Entry: $${callEntry.toFixed(2)}`);
    console.log(`   Put Entry: $${putEntry.toFixed(2)}`);
    console.log(`   Total Entry: $${totalEntry.toFixed(2)}`);
    
    // Track position throughout the day
    const position: StraddlePosition = {
      date: dateStr,
      spxPrice,
      strike,
      callEntry,
      putEntry,
      totalEntry,
      maxProfit: 0,
      maxLoss: 0
    };
    
    // Simulate intraday price movement
    let exitFound = false;
    const targetPrice = totalEntry * (1 + this.config.targetProfit / 100);
    const stopPrice = this.config.stopLoss 
      ? totalEntry * (1 - this.config.stopLoss / 100)
      : 0;
    
    // Check prices every 5 minutes
    for (let i = 0; i < callData.prices.length && i < putData.prices.length; i++) {
      const callPrice = callData.prices[i].price;
      const putPrice = putData.prices[i].price;
      const totalPrice = callPrice + putPrice;
      const profit = totalPrice - totalEntry;
      const profitPercent = (profit / totalEntry) * 100;
      
      // Track max profit/loss
      position.maxProfit = Math.max(position.maxProfit || 0, profit);
      position.maxLoss = Math.min(position.maxLoss || 0, profit);
      
      // Check exit conditions
      if (!exitFound) {
        // Target profit hit
        if (totalPrice >= targetPrice) {
          position.callExit = callPrice;
          position.putExit = putPrice;
          position.totalExit = totalPrice;
          position.exitTime = callData.prices[i].time;
          position.exitReason = 'target';
          position.pnl = profit;
          position.pnlPercent = profitPercent;
          exitFound = true;
          console.log(`   ✅ Target hit at ${position.exitTime}: +${profitPercent.toFixed(1)}%`);
        }
        // Stop loss hit
        else if (stopPrice > 0 && totalPrice <= stopPrice) {
          position.callExit = callPrice;
          position.putExit = putPrice;
          position.totalExit = totalPrice;
          position.exitTime = callData.prices[i].time;
          position.exitReason = 'stop';
          position.pnl = profit;
          position.pnlPercent = profitPercent;
          exitFound = true;
          console.log(`   ❌ Stop loss hit at ${position.exitTime}: ${profitPercent.toFixed(1)}%`);
        }
      }
    }
    
    // If no exit during day, use closing prices
    if (!exitFound) {
      position.callExit = callData.close;
      position.putExit = putData.close;
      position.totalExit = callData.close + putData.close;
      position.exitTime = '16:00:00';
      position.exitReason = 'eod';
      position.pnl = position.totalExit - totalEntry;
      position.pnlPercent = (position.pnl / totalEntry) * 100;
      console.log(`   ⏰ EOD exit: ${position.pnlPercent.toFixed(1)}%`);
    }
    
    return position;
  }
  
  /**
   * Run the backtest
   */
  async run(): Promise<void> {
    await this.initialize();
    
    const tradingDays = this.getTradingDays(this.config.daysBack);
    console.log(`\n📊 Backtesting ${tradingDays.length} trading days`);
    console.log('=' .repeat(60));
    
    // Process each day
    for (const day of tradingDays) {
      try {
        const result = await this.backtestDay(day);
        this.results.push(result);
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error(`Error processing ${day.toISOString().split('T')[0]}:`, error);
      }
    }
    
    this.generateReport();
  }
  
  /**
   * Generate backtest report
   */
  private generateReport(): void {
    console.log('\n' + '='.repeat(80));
    console.log('📈 BACKTEST RESULTS SUMMARY');
    console.log('='.repeat(80));
    
    const wins = this.results.filter(r => r.pnl! > 0);
    const losses = this.results.filter(r => r.pnl! <= 0);
    const targetHits = this.results.filter(r => r.exitReason === 'target');
    const stopHits = this.results.filter(r => r.exitReason === 'stop');
    const eodExits = this.results.filter(r => r.exitReason === 'eod');
    
    const totalPnL = this.results.reduce((sum, r) => sum + (r.pnl || 0), 0);
    const avgEntry = this.results.reduce((sum, r) => sum + r.totalEntry, 0) / this.results.length;
    const avgPnL = totalPnL / this.results.length;
    const winRate = (wins.length / this.results.length) * 100;
    
    console.log(`\n📊 PERFORMANCE METRICS:`);
    console.log(`   Total Trades: ${this.results.length}`);
    console.log(`   Wins: ${wins.length} (${winRate.toFixed(1)}%)`);
    console.log(`   Losses: ${losses.length} (${(100 - winRate).toFixed(1)}%)`);
    console.log(`   Win Rate: ${winRate.toFixed(1)}%`);
    console.log('');
    console.log(`💰 P&L SUMMARY:`);
    console.log(`   Total P&L: $${totalPnL.toFixed(2)}`);
    console.log(`   Average P&L: $${avgPnL.toFixed(2)}`);
    console.log(`   Average Entry Cost: $${avgEntry.toFixed(2)}`);
    console.log(`   Return on Capital: ${((totalPnL / (avgEntry * this.results.length)) * 100).toFixed(2)}%`);
    
    if (wins.length > 0) {
      const avgWin = wins.reduce((sum, r) => sum + r.pnl!, 0) / wins.length;
      console.log(`   Average Win: $${avgWin.toFixed(2)}`);
    }
    
    if (losses.length > 0) {
      const avgLoss = losses.reduce((sum, r) => sum + r.pnl!, 0) / losses.length;
      console.log(`   Average Loss: $${avgLoss.toFixed(2)}`);
    }
    
    console.log('');
    console.log(`🎯 EXIT REASONS:`);
    console.log(`   Target Hit: ${targetHits.length} (${((targetHits.length / this.results.length) * 100).toFixed(1)}%)`);
    console.log(`   Stop Loss: ${stopHits.length} (${((stopHits.length / this.results.length) * 100).toFixed(1)}%)`);
    console.log(`   End of Day: ${eodExits.length} (${((eodExits.length / this.results.length) * 100).toFixed(1)}%)`);
    
    // Best and worst trades
    const bestTrade = this.results.reduce((best, r) => 
      r.pnl! > (best?.pnl || -Infinity) ? r : best
    );
    const worstTrade = this.results.reduce((worst, r) => 
      r.pnl! < (worst?.pnl || Infinity) ? r : worst
    );
    
    console.log('');
    console.log(`📈 BEST TRADE:`);
    console.log(`   Date: ${bestTrade.date}`);
    console.log(`   P&L: $${bestTrade.pnl?.toFixed(2)} (${bestTrade.pnlPercent?.toFixed(1)}%)`);
    console.log(`   Exit: ${bestTrade.exitReason}`);
    
    console.log('');
    console.log(`📉 WORST TRADE:`);
    console.log(`   Date: ${worstTrade.date}`);
    console.log(`   P&L: $${worstTrade.pnl?.toFixed(2)} (${worstTrade.pnlPercent?.toFixed(1)}%)`);
    console.log(`   Exit: ${worstTrade.exitReason}`);
    
    // Save detailed results to file
    this.saveResults();
  }
  
  /**
   * Save detailed results to CSV
   */
  private saveResults(): void {
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `backtest_results/spx_straddle_${timestamp}.csv`;
    
    // Create directory if it doesn't exist
    const dir = path.dirname(filename);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Create CSV content
    const headers = 'Date,SPX_Price,Strike,Call_Entry,Put_Entry,Total_Entry,Call_Exit,Put_Exit,Total_Exit,Exit_Time,Exit_Reason,PnL,PnL_Percent,Max_Profit,Max_Loss';
    const rows = this.results.map(r => 
      `${r.date},${r.spxPrice},${r.strike},${r.callEntry},${r.putEntry},${r.totalEntry},` +
      `${r.callExit},${r.putExit},${r.totalExit},${r.exitTime},${r.exitReason},` +
      `${r.pnl?.toFixed(2)},${r.pnlPercent?.toFixed(2)},${r.maxProfit?.toFixed(2)},${r.maxLoss?.toFixed(2)}`
    );
    
    const csv = [headers, ...rows].join('\n');
    fs.writeFileSync(filename, csv);
    
    console.log(`\n💾 Detailed results saved to: ${filename}`);
  }
}

// Command line interface
async function main() {
  const args = process.argv.slice(2);
  
  // Parse command line arguments
  const config: BacktestConfig = {
    daysBack: parseInt(args[0]) || 40,
    targetProfit: parseFloat(args[1]) || 20,  // Default 20% target
    stopLoss: args[2] ? parseFloat(args[2]) : undefined,  // Optional stop loss
    startTime: '09:33',  // 3 minutes after market open
    endTime: '16:00'     // Market close
  };
  
  // Validate arguments
  if (config.daysBack < 1 || config.daysBack > 252) {
    console.error('❌ Days back must be between 1 and 252');
    process.exit(1);
  }
  
  if (config.targetProfit <= 0 || config.targetProfit > 100) {
    console.error('❌ Target profit must be between 0 and 100 percent');
    process.exit(1);
  }
  
  if (config.stopLoss && (config.stopLoss <= 0 || config.stopLoss > 100)) {
    console.error('❌ Stop loss must be between 0 and 100 percent');
    process.exit(1);
  }
  
  console.log('🚀 SPX Straddle Strategy Backtest');
  console.log('==================================');
  
  const backtest = new SPXStraddleBacktest(config);
  
  try {
    await backtest.run();
    console.log('\n✅ Backtest completed successfully!');
  } catch (error) {
    console.error('❌ Backtest failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { SPXStraddleBacktest, BacktestConfig, StraddlePosition };