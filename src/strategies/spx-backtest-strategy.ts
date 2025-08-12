// SPX Backtest Strategy - Port of proven spx-20day-backtest logic
// This strategy replicates the exact logic from the successful backtest

import { BaseStrategy } from './base-strategy';
import { 
  StrategyConfig, 
  Signal, 
  MarketContext, 
  ConditionGroup
} from '../types/strategy';
import { MACDStudy } from '../studies/macd';
import { Bar } from '../types/tradestation';

interface SPXBacktestParams {
  macdFastPeriod: number;        // 12
  macdSlowPeriod: number;        // 26  
  macdSignalPeriod: number;      // 9
  macdThreshold: number;         // -1.0 (proven in backtest)
  profitTarget: number;          // 1.0 ($1 profit target)
  stopLossPercentage: number;    // 0.20 (20% stop loss)
}

interface OptionPosition {
  symbol: string;
  entryPrice: number;
  entryTime: Date;
  strikePrice: number;
  quantity: number;
  spxPriceAtEntry: number;
  initialMacdHistogram: number;
}

export class SPXBacktestStrategy extends BaseStrategy {
  private macdStudy: MACDStudy;
  private spxSymbol = '$SPXW.X';
  private currentPosition: OptionPosition | null = null;
  
  // History tracking (ported from backtest)
  private histogramHistory: number[] = [];
  private macdHistory: number[] = [];
  private prices: number[] = []; // Store prices for accurate EMA calculation
  
  // State tracking
  private previousMacd: number | null = null;
  private previousSignal: number | null = null;
  private previousHistogram: number | null = null;

  constructor(config: StrategyConfig) {
    super(config);
    
    const params = config.parameters as SPXBacktestParams;
    this.macdStudy = new MACDStudy(
      params.macdFastPeriod || 12,
      params.macdSlowPeriod || 26, 
      params.macdSignalPeriod || 9
    );
  }

  protected defineEntryConditions(): ConditionGroup {
    return {
      id: 'spx-backtest-entry',
      name: 'SPX Backtest Entry Conditions',
      operator: 'AND',
      conditions: []
    };
  }

  protected defineExitConditions(): ConditionGroup {
    return {
      id: 'spx-backtest-exit',
      name: 'SPX Backtest Exit Conditions', 
      operator: 'OR',
      conditions: []
    };
  }

  protected async calculateIndicators(context: MarketContext): Promise<Map<string, number | number[]>> {
    const indicators = new Map<string, number | number[]>();
    
    if (context.symbol === this.spxSymbol) {
      // Store price for our custom MACD calculation
      const price = parseFloat(context.currentBar.Close);
      this.prices.push(price);
      
      // Keep only last 100 prices for memory management
      if (this.prices.length > 100) {
        this.prices = this.prices.slice(-100);
      }
      
      this.macdStudy.addBar(context.currentBar);
      const macdValues = this.calculateMACD(context.currentBar);
      
      // Debug logging - check our price data
      this.logger.debug(`🔍 MACD calculation for ${context.symbol}:`, {
        barPrice: context.currentBar.Close,
        pricesLength: this.prices.length,
        lastFewPrices: this.prices.slice(-5),
        macdValues: macdValues ? {
          macd: macdValues.macd,
          signal: macdValues.signal,
          histogram: macdValues.histogram,
          crossover: macdValues.crossover
        } : null
      });
      
      if (macdValues) {
        indicators.set('macd', macdValues.macd);
        indicators.set('macd_signal', macdValues.signal);
        indicators.set('macd_histogram', macdValues.histogram);
        indicators.set('macd_crossover', macdValues.crossover === 'bullish' ? 1 : 
                     macdValues.crossover === 'bearish' ? -1 : 0);
        
        this.logger.info(`📊 MACD Calculated: ${macdValues.macd.toFixed(4)}, Signal: ${macdValues.signal.toFixed(4)}, Histogram: ${macdValues.histogram.toFixed(4)}`);
      } else {
        this.logger.warn('⚠️ MACD calculation returned null - insufficient data');
      }
    }
    
    return indicators;
  }

  /**
   * Calculate XAverage exactly like TradeStation EasyLanguage
   * XAverage = XAverage[1] + SmoothingFactor * (Price - XAverage[1])
   * where SmoothingFactor = 2 / (Length + 1)
   */
  private calculateTradeStationEMA(values: number[], length: number): number | null {
    if (values.length < 1) {
      return null;
    }
    
    const smoothingFactor = 2 / (length + 1);
    let ema = values[0]; // Start with first price (CurrentBar = 1)
    
    // Apply TradeStation's XAverage formula
    for (let i = 1; i < values.length; i++) {
      ema = ema + smoothingFactor * (values[i] - ema);
    }
    
    return ema;
  }

  /**
   * Calculate MACD values with crossover detection (ported from backtest)
   */
  private calculateMACD(bar: Bar): { macd: number; signal: number; histogram: number; crossover: string } | null {
    // Get current bar price
    const currentPrice = parseFloat(bar.Close);
    
    // We need at least some prices to start calculation like TradeStation
    const prices = this.prices || [];
    if (prices.length < 1) {
      return null;
    }
    
    // Calculate TradeStation MACD: XAverage(Price, 12) - XAverage(Price, 26)
    const fastEMA = this.calculateTradeStationEMA(prices, 12); // FastLength = 12
    const slowEMA = this.calculateTradeStationEMA(prices, 26); // SlowLength = 26
    
    if (fastEMA === null || slowEMA === null) {
      return null;
    }
    
    // MyMACD = MACD(Close, FastLength, SlowLength)
    const macd = fastEMA - slowEMA;
    
    // Store MACD values for signal line calculation
    this.macdHistory.push(macd);
    if (this.macdHistory.length > 100) {
      this.macdHistory = this.macdHistory.slice(-100);
    }
    
    // MACDAvg = XAverage(MyMACD, MACDLength) - 9 period EMA of MACD
    let signal = 0;
    if (this.macdHistory.length >= 1) {
      signal = this.calculateTradeStationEMA(this.macdHistory, 9) || 0; // MACDLength = 9
    }
    
    // MACDDiff = MyMACD - MACDAvg (this is the histogram)
    const histogram = macd - signal;

    // Detect crossover (ported logic from backtest)
    let crossover = 'none';
    if (this.previousMacd !== null && this.previousSignal !== null) {
      if (this.previousMacd <= this.previousSignal && macd > signal) {
        crossover = 'bullish';
      } else if (this.previousMacd >= this.previousSignal && macd < signal) {
        crossover = 'bearish';
      }
    }

    // Update previous values
    this.previousMacd = macd;
    this.previousSignal = signal;
    this.previousHistogram = histogram;

    return { macd, signal, histogram, crossover };
  }

  /**
   * Check if histogram is increasing over last 4 bars (ported from backtest)
   */
  private isHistogramIncreasing(currentHistogram: number): boolean {
    // Need at least 3 previous histogram values + current = 4 total
    if (this.histogramHistory.length < 3) {
      return false;
    }
    
    // Create array of last 3 previous values + current value
    const last4Values = [...this.histogramHistory.slice(-3), currentHistogram];
    
    // Check if each value is greater than the previous (increasing/becoming more bullish)
    for (let i = 1; i < last4Values.length; i++) {
      if (last4Values[i] <= last4Values[i - 1]) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Check if MACD was below threshold in recent bars (ported from backtest)
   */
  private wasMacdBelowThreshold(currentMacd: number): boolean {
    const threshold = (this.config.parameters as SPXBacktestParams).macdThreshold || -1.0;
    
    // Check current MACD
    if (currentMacd <= threshold) {
      return true;
    }
    
    // Check recent MACD history
    for (const macd of this.macdHistory) {
      if (macd <= threshold) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if within entry hours (before 3:30 PM ET)
   */
  private isWithinEntryHours(timestamp: string): boolean {
    const date = new Date(timestamp);
    
    // Convert to Eastern Time
    const etTime = new Date(date.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const hours = etTime.getHours();
    const minutes = etTime.getMinutes();
    
    // Market hours: 9:30 AM - 4:00 PM ET
    // Entry cutoff: 3:30 PM ET (15:30)
    if (hours < 9 || (hours === 9 && minutes < 30)) return false; // Before market open
    if (hours > 15 || (hours === 15 && minutes >= 30)) return false; // After 3:30 PM ET
    
    return true;
  }

  /**
   * Construct option symbol (ported from backtest)
   */
  private constructOptionSymbol(bar: Bar): string {
    const date = new Date(bar.TimeStamp);
    const spxPrice = parseFloat(bar.Close);
    
    // Round down to nearest $5 for SPX options
    const strike = Math.floor(spxPrice / 5) * 5;
    
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `SPXW ${year}${month}${day}C${strike}`;
  }

  async generateSignals(context: MarketContext): Promise<Signal[]> {
    // Only generate signals for SPX data
    if (context.symbol !== this.spxSymbol) {
      return [];
    }

    const signals: Signal[] = [];
    const macdValue = context.indicators.get('macd') as number;
    const macdHistogram = context.indicators.get('macd_histogram') as number;
    const macdCrossover = context.indicators.get('macd_crossover') as number;
    
    try {
      // Entry Logic (exact port from backtest)
      if (!this.currentPosition && 
          macdValue <= (this.config.parameters as SPXBacktestParams).macdThreshold && 
          macdCrossover === 1 &&
          this.isHistogramIncreasing(macdHistogram) &&
          this.isWithinEntryHours(context.currentBar.TimeStamp)) {
        
        const optionSymbol = this.constructOptionSymbol(context.currentBar);
        
        const signal: Signal = {
          id: `spx_backtest_entry_${Date.now()}`,
          symbol: optionSymbol,
          type: 'BUY',
          timestamp: new Date(),
          price: parseFloat(context.currentBar.Close), // Will be updated with option price
          quantity: 1,
          confidence: 0.90,
          reason: `SPX Backtest Entry: MACD ≤ ${(this.config.parameters as SPXBacktestParams).macdThreshold}, bullish crossover, histogram increasing`,
          metadata: {
            strategyId: this.id,
            underlyingSymbol: this.spxSymbol,
            macdValue,
            macdHistogram,
            spxPrice: parseFloat(context.currentBar.Close),
            strikePrice: Math.floor(parseFloat(context.currentBar.Close) / 5) * 5
          }
        };
        
        signals.push(signal);
      }
      
      // Exit Logic (exact port from backtest)
      if (this.currentPosition) {
        const params = this.config.parameters as SPXBacktestParams;
        const currentOptionPrice = parseFloat(context.currentBar.Close); // Should be option price
        const unrealizedProfit = (currentOptionPrice - this.currentPosition.entryPrice) * this.currentPosition.quantity * 100;
        
        // Exit conditions
        const profitTargetReached = unrealizedProfit >= (params.profitTarget || 1.0);
        const stopLossHit = (this.currentPosition.entryPrice - currentOptionPrice) / this.currentPosition.entryPrice >= (params.stopLossPercentage || 0.20);
        const bearishCrossover = macdCrossover === -1;
        
        let exitReason = '';
        if (profitTargetReached && macdHistogram < this.previousHistogram!) {
          exitReason = 'Profit target reached AND momentum shrinking';
        } else if (stopLossHit) {
          exitReason = 'Stop loss triggered';
        } else if (bearishCrossover) {
          exitReason = 'Negative crossover signal (bearish MACD crossover)';
        }
        
        if (exitReason) {
          const signal: Signal = {
            id: `spx_backtest_exit_${Date.now()}`,
            symbol: this.currentPosition.symbol,
            type: 'SELL',
            timestamp: new Date(),
            price: currentOptionPrice,
            quantity: this.currentPosition.quantity,
            confidence: 0.95,
            reason: exitReason,
            metadata: {
              strategyId: this.id,
              unrealizedProfit,
              holdTimeMinutes: Math.floor((new Date().getTime() - this.currentPosition.entryTime.getTime()) / 60000)
            }
          };
          signals.push(signal);
        }
      }
      
      // Update histories AFTER processing (important for next bar)
      this.histogramHistory.push(macdHistogram);
      if (this.histogramHistory.length > 4) {
        this.histogramHistory.shift();
      }
      
      this.macdHistory.push(macdValue);
      if (this.macdHistory.length > 4) {
        this.macdHistory.shift();
      }
      
    } catch (error) {
      this.logger.error('Error generating SPX backtest signals:', error);
    }
    
    return signals;
  }

  async onOrderFilled(order: any, context: MarketContext): Promise<void> {
    await super.onOrderFilled(order, context);
    
    try {
      const symbol = order.Symbol;
      const quantity = parseFloat(order.Quantity || '0');
      const price = parseFloat(order.FilledPrice || '0');
      const side = order.TradeAction;
      
      if (side === 'BUY' && symbol.startsWith('SPXW')) {
        // Parse strike price from symbol
        const strikeMatch = symbol.match(/C(\d+)$/);
        const strikePrice = strikeMatch ? parseInt(strikeMatch[1]) : 0;
        
        this.currentPosition = {
          symbol,
          entryPrice: price,
          entryTime: new Date(),
          strikePrice,
          quantity,
          spxPriceAtEntry: parseFloat(context.currentBar.Close),
          initialMacdHistogram: this.previousHistogram || 0
        };
        
        this.logger.info(`SPX Backtest: Opened position ${symbol} at $${price}`);
        
      } else if (side === 'SELL' && this.currentPosition?.symbol === symbol) {
        const profit = (price - this.currentPosition.entryPrice) * quantity * 100;
        const holdTime = Math.floor((new Date().getTime() - this.currentPosition.entryTime.getTime()) / 60000);
        
        this.logger.info(`SPX Backtest: Closed position ${symbol} at $${price}, P&L: $${profit.toFixed(2)}, Hold: ${holdTime}min`);
        this.currentPosition = null;
      }
    } catch (error) {
      this.logger.error('Error processing SPX backtest order fill:', error);
    }
  }

  protected getMaxLookbackPeriod(): number {
    const params = this.config.parameters as SPXBacktestParams;
    return Math.max(params.macdSlowPeriod || 26, 50);
  }

  // Utility method for debugging
  getStrategyState() {
    return {
      currentPosition: this.currentPosition,
      histogramHistoryLength: this.histogramHistory.length,
      macdHistoryLength: this.macdHistory.length,
      previousValues: {
        macd: this.previousMacd,
        signal: this.previousSignal,
        histogram: this.previousHistogram
      }
    };
  }
}