import { createLogger } from './logger-config';

interface Trade {
  id: string;
  symbol: string;
  entryTime: Date;
  exitTime?: Date;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  side: 'buy' | 'sell';
  status: 'open' | 'closed';
  pnl?: number;
  pnlPercent?: number;
  macdHistory?: MACDPoint[];
  triggerReason?: string;
  strike?: number;
}

interface MACDPoint {
  timestamp: Date;
  macd: number;
  signal: number;
  histogram: number;
}

interface DailySummary {
  date: string;
  trades: Trade[];
  totalPnL: number;
  winningTrades: number;
  losingTrades: number;
  openTrades: number;
  winRate: number;
}

export class TradeReporter {
  private trades: Map<string, Trade> = new Map();
  private logger = createLogger();
  
  constructor(private readonly silent: boolean = false) {
    // In cloud mode, only report summaries
    if (process.env.RUNNING_IN_CLOUD === 'true') {
      this.silent = false; // Always show summaries in cloud
    }
  }
  
  addTrade(trade: Trade): void {
    this.trades.set(trade.id, trade);
  }
  
  updateTrade(tradeId: string, updates: Partial<Trade>): void {
    const trade = this.trades.get(tradeId);
    if (trade) {
      Object.assign(trade, updates);
      
      // Calculate P&L if trade is closed
      if (updates.exitPrice && trade.entryPrice) {
        const pnl = (updates.exitPrice - trade.entryPrice) * trade.quantity;
        const pnlPercent = ((updates.exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
        trade.pnl = pnl;
        trade.pnlPercent = pnlPercent;
        trade.status = 'closed';
      }
    }
  }
  
  // Generate daily summary report
  generateDailySummary(): DailySummary {
    const today = new Date().toISOString().split('T')[0];
    const todaysTrades = Array.from(this.trades.values()).filter(trade => {
      const tradeDate = trade.entryTime.toISOString().split('T')[0];
      return tradeDate === today;
    });
    
    const closedTrades = todaysTrades.filter(t => t.status === 'closed');
    const winningTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
    const losingTrades = closedTrades.filter(t => (t.pnl || 0) < 0);
    const openTrades = todaysTrades.filter(t => t.status === 'open');
    
    const totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winRate = closedTrades.length > 0 
      ? (winningTrades.length / closedTrades.length) * 100 
      : 0;
    
    return {
      date: today,
      trades: todaysTrades,
      totalPnL,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      openTrades: openTrades.length,
      winRate
    };
  }
  
  // Format MACD histogram for display
  formatMACDHistory(history: MACDPoint[], showBars: number = 4): string {
    if (!history || history.length === 0) return 'No MACD data';
    
    // Get the last N bars before the cross
    const lastBars = history.slice(-showBars);
    
    return lastBars.map(point => {
      const hist = point.histogram;
      const bar = hist > 0 ? '█'.repeat(Math.min(Math.abs(hist) * 10, 5)) : '';
      const sign = hist > 0 ? '+' : '';
      return `${sign}${hist.toFixed(3)} ${bar}`;
    }).join(' | ');
  }
  
  // Print summary report (minimal for cloud, detailed for local)
  printSummary(): void {
    const summary = this.generateDailySummary();
    const isCloud = process.env.RUNNING_IN_CLOUD === 'true';
    
    if (isCloud) {
      // Minimal cloud output
      console.log(`[${summary.date}] Trades: ${summary.trades.length} | P&L: $${summary.totalPnL.toFixed(2)} | Win Rate: ${summary.winRate.toFixed(1)}%`);
      
      // Only show trades with activity
      if (summary.trades.length > 0) {
        summary.trades.forEach(trade => {
          const status = trade.status === 'closed' 
            ? `Closed: $${trade.pnl?.toFixed(2)} (${trade.pnlPercent?.toFixed(2)}%)`
            : 'Open';
          console.log(`  ${trade.symbol} @ ${trade.entryPrice} | ${status}`);
        });
      }
    } else {
      // Detailed local output
      console.log('\n' + '='.repeat(80));
      console.log(`DAILY TRADE SUMMARY - ${summary.date}`);
      console.log('='.repeat(80));
      
      console.log(`\nSUMMARY STATISTICS:`);
      console.log(`  Total Trades: ${summary.trades.length}`);
      console.log(`  Closed: ${summary.winningTrades + summary.losingTrades} (Winners: ${summary.winningTrades}, Losers: ${summary.losingTrades})`);
      console.log(`  Open: ${summary.openTrades}`);
      console.log(`  Total P&L: $${summary.totalPnL.toFixed(2)}`);
      console.log(`  Win Rate: ${summary.winRate.toFixed(1)}%`);
      
      if (summary.trades.length > 0) {
        console.log(`\nTRADE DETAILS:`);
        console.log('-'.repeat(80));
        
        summary.trades.forEach((trade, index) => {
          console.log(`\nTrade #${index + 1}: ${trade.symbol}`);
          console.log(`  Entry: ${trade.entryTime.toLocaleTimeString()} @ $${trade.entryPrice.toFixed(2)}`);
          
          if (trade.strike) {
            console.log(`  Strike: $${trade.strike}`);
          }
          
          if (trade.macdHistory) {
            console.log(`  MACD Histogram (last 4 bars):`);
            console.log(`    ${this.formatMACDHistory(trade.macdHistory, 4)}`);
          }
          
          if (trade.status === 'closed' && trade.exitTime && trade.exitPrice) {
            console.log(`  Exit: ${trade.exitTime.toLocaleTimeString()} @ $${trade.exitPrice.toFixed(2)}`);
            const pnlColor = trade.pnl! > 0 ? '\x1b[32m' : '\x1b[31m'; // Green or Red
            console.log(`  P&L: ${pnlColor}$${trade.pnl!.toFixed(2)} (${trade.pnlPercent!.toFixed(2)}%)\x1b[0m`);
          } else {
            console.log(`  Status: OPEN - Current unrealized P&L pending`);
          }
          
          if (trade.triggerReason) {
            console.log(`  Trigger: ${trade.triggerReason}`);
          }
        });
      }
      
      console.log('\n' + '='.repeat(80));
    }
  }
  
  // Schedule periodic summary reports
  startPeriodicReporting(intervalMinutes: number = 10): void {
    // Initial report
    this.printSummary();
    
    // Schedule periodic reports
    setInterval(() => {
      this.printSummary();
    }, intervalMinutes * 60 * 1000);
    
    // Also report at market close (4 PM ET)
    const now = new Date();
    const closeTime = new Date();
    closeTime.setHours(16, 0, 0, 0); // 4 PM
    
    if (now < closeTime) {
      const msUntilClose = closeTime.getTime() - now.getTime();
      setTimeout(() => {
        console.log('\n*** MARKET CLOSE SUMMARY ***');
        this.printSummary();
      }, msUntilClose);
    }
  }
}

// Export singleton instance
export const tradeReporter = new TradeReporter();