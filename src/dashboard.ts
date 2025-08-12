// Simple CLI Dashboard for Trading Bot
// Provides real-time status updates and activity monitoring

import { EventEmitter } from 'events';
import { SimpleTradingBot } from './simple-trading-bot';

interface DashboardConfig {
  updateInterval: number; // seconds
  showDetailedLogs: boolean;
  clearScreen: boolean;
}

export class TradingDashboard extends EventEmitter {
  private bot: SimpleTradingBot;
  private config: DashboardConfig;
  private updateTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private startTime: Date = new Date();
  
  // Statistics
  private stats = {
    totalTrades: 0,
    totalProfit: 0,
    winningTrades: 0,
    losingTrades: 0,
    maxDrawdown: 0,
    maxProfit: 0,
    averageHoldTime: 0,
    totalHoldTime: 0
  };

  // Activity log (last 10 activities)
  private activityLog: string[] = [];

  constructor(bot: SimpleTradingBot, config: Partial<DashboardConfig> = {}) {
    super();
    this.bot = bot;
    this.config = {
      updateInterval: 10, // 10 seconds
      showDetailedLogs: false,
      clearScreen: true,
      ...config
    };
    
    this.setupBotEventListeners();
  }

  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.startTime = new Date();
    
    // Initial display
    this.displayDashboard();
    
    // Start update timer
    this.updateTimer = setInterval(() => {
      this.displayDashboard();
    }, this.config.updateInterval * 1000);
    
    this.addActivity('🚀 Dashboard started');
  }

  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    this.addActivity('🛑 Dashboard stopped');
  }

  private setupBotEventListeners(): void {
    this.bot.on('started', () => {
      this.addActivity('✅ Trading bot started');
    });

    this.bot.on('stopped', () => {
      this.addActivity('🛑 Trading bot stopped');
    });

    this.bot.on('error', (error) => {
      this.addActivity(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    });

    this.bot.on('positionOpened', (position) => {
      this.addActivity(`🚀 OPENED: ${position.symbol} @ $${position.entryPrice.toFixed(2)}`);
    });

    this.bot.on('positionClosed', (result) => {
      const profit = result.profit;
      const isWin = profit > 0;
      
      // Update statistics
      this.stats.totalTrades++;
      this.stats.totalProfit += profit;
      this.stats.totalHoldTime += result.holdTime;
      this.stats.averageHoldTime = this.stats.totalHoldTime / this.stats.totalTrades;
      
      if (isWin) {
        this.stats.winningTrades++;
        this.stats.maxProfit = Math.max(this.stats.maxProfit, profit);
      } else {
        this.stats.losingTrades++;
        this.stats.maxDrawdown = Math.min(this.stats.maxDrawdown, profit);
      }
      
      const profitStr = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`;
      this.addActivity(`🏁 CLOSED: ${result.position.symbol} (${profitStr}) ${result.holdTime}min`);
    });
  }

  private addActivity(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `${timestamp} ${message}`;
    
    this.activityLog.unshift(logEntry);
    if (this.activityLog.length > 10) {
      this.activityLog.pop();
    }
  }

  private displayDashboard(): void {
    if (this.config.clearScreen) {
      console.clear();
    }
    
    const status = this.bot.getStatus();
    const uptime = Math.floor((new Date().getTime() - this.startTime.getTime()) / 1000);
    const uptimeStr = this.formatUptime(uptime);
    
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                    📊 SPX TRADING BOT DASHBOARD              ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ Status: ${status.isRunning ? '🟢 RUNNING' : '🔴 STOPPED'}     │ Uptime: ${uptimeStr.padEnd(20)}║`);
    console.log(`║ Data: ${status.spxBarsCount.toString().padEnd(6)} SPX bars│ MACD History: ${status.macdHistoryLength.toString().padEnd(12)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    
    // Current Position
    if (status.currentPosition) {
      const pos = status.currentPosition;
      const pnl = pos.unrealizedPnL || 0;
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      const holdTime = Math.floor((new Date().getTime() - pos.entryTime.getTime()) / 60000);
      
      console.log('║ 📍 CURRENT POSITION:                                        ║');
      console.log(`║ Symbol: ${pos.symbol.padEnd(20)} │ Entry: $${pos.entryPrice.toFixed(2).padEnd(8)}║`);
      console.log(`║ P&L: ${pnlStr.padEnd(10)} │ Hold Time: ${holdTime.toString().padEnd(4)} min     ║`);
      console.log(`║ SPX@Entry: $${pos.spxPriceAtEntry.toFixed(2).padEnd(8)}│ Current: $${(pos.currentPrice || 0).toFixed(2).padEnd(8)}║`);
    } else {
      console.log('║ 📍 CURRENT POSITION: None                                   ║');
    }
    
    console.log('╠══════════════════════════════════════════════════════════════╣');
    
    // Trading Statistics
    const winRate = this.stats.totalTrades > 0 ? (this.stats.winningTrades / this.stats.totalTrades * 100) : 0;
    const totalPnLStr = `${this.stats.totalProfit >= 0 ? '+' : ''}$${this.stats.totalProfit.toFixed(2)}`;
    
    console.log('║ 📈 TRADING STATISTICS:                                       ║');
    console.log(`║ Total Trades: ${this.stats.totalTrades.toString().padEnd(8)}│ Win Rate: ${winRate.toFixed(1)}%     ║`);
    console.log(`║ Total P&L: ${totalPnLStr.padEnd(12)}│ Wins/Losses: ${this.stats.winningTrades}/${this.stats.losingTrades}    ║`);
    console.log(`║ Max Profit: $${this.stats.maxProfit.toFixed(2).padEnd(8)}│ Max Loss: $${Math.abs(this.stats.maxDrawdown).toFixed(2).padEnd(8)}║`);
    console.log(`║ Avg Hold: ${this.stats.averageHoldTime.toFixed(1).padEnd(6)} min   │                          ║`);
    
    console.log('╠══════════════════════════════════════════════════════════════╣');
    
    // Recent Activity
    console.log('║ 📋 RECENT ACTIVITY:                                          ║');
    if (this.activityLog.length === 0) {
      console.log('║ No recent activity...                                        ║');
    } else {
      for (let i = 0; i < Math.min(5, this.activityLog.length); i++) {
        const activity = this.activityLog[i];
        const truncated = activity.length > 60 ? activity.substring(0, 57) + '...' : activity;
        console.log(`║ ${truncated.padEnd(60)}║`);
      }
    }
    
    console.log('╠══════════════════════════════════════════════════════════════╣');
    
    // Strategy Info
    console.log('║ ⚙️  STRATEGY: SPX MACD Momentum                              ║');
    console.log('║ Entry: MACD ≤ -1.0 + Bullish crossover + Histogram rising   ║');
    console.log('║ Exit: $100 profit + momentum decline, 20% stop, bearish X   ║');
    console.log('║ Hours: 9:30-15:30 ET │ Mode: Paper Trading 📄              ║');
    
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Press Ctrl+C to stop the bot');
    console.log(`Last Update: ${new Date().toLocaleTimeString()}`);
  }

  private formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  // Public methods for manual updates
  refreshNow(): void {
    this.displayDashboard();
  }

  getStatistics(): typeof this.stats {
    return { ...this.stats };
  }

  getRecentActivity(): string[] {
    return [...this.activityLog];
  }
}