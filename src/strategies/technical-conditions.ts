// Technical Indicator Conditions for Strategy Evaluation

import { TechnicalConditionConfig, MarketContext, ComparisonOperator } from '@/types/strategy';

export class TechnicalConditions {
  
  /**
   * Evaluate technical indicator conditions
   */
  evaluate(config: TechnicalConditionConfig, context: MarketContext): boolean {
    try {
      const { indicator, operator, value } = config.parameters;
      
      // Get indicator value from context
      const indicatorValue = this.getIndicatorValue(indicator, context);
      
      if (indicatorValue === null || indicatorValue === undefined) {
        return false;
      }
      
      return this.compareValues(indicatorValue, value, operator);
      
    } catch (error) {
      console.warn('Technical condition evaluation error:', error);
      return false;
    }
  }
  
  private getIndicatorValue(indicator: string, context: MarketContext): number | null {
    // Get indicator value from the context indicators map
    const value = context.indicators.get(indicator);
    
    if (typeof value === 'number') {
      return value;
    }
    
    if (Array.isArray(value) && value.length > 0) {
      // Return the most recent value for array indicators
      return value[value.length - 1];
    }
    
    // Handle specific indicators
    switch (indicator) {
      case 'sma':
        return this.calculateSMA(context, 20); // Default 20-period SMA
      case 'ema':
        return this.calculateEMA(context, 20); // Default 20-period EMA  
      case 'rsi':
        return this.calculateRSI(context, 14); // Default 14-period RSI
      case 'macd':
        return context.indicators.get('macd') as number || null;
      case 'macd_signal':
        return context.indicators.get('macd_signal') as number || null;
      case 'macd_histogram':
        return context.indicators.get('macd_histogram') as number || null;
      default:
        return null;
    }
  }
  
  private calculateSMA(context: MarketContext, period: number): number | null {
    const bars = [...context.previousBars, context.currentBar];
    if (bars.length < period) return null;
    
    const recentBars = bars.slice(-period);
    const sum = recentBars.reduce((total, bar) => total + parseFloat(bar.Close), 0);
    
    return sum / period;
  }
  
  private calculateEMA(context: MarketContext, period: number): number | null {
    const bars = [...context.previousBars, context.currentBar];
    if (bars.length < period) return null;
    
    const multiplier = 2 / (period + 1);
    let ema = parseFloat(bars[0].Close);
    
    for (let i = 1; i < bars.length; i++) {
      const price = parseFloat(bars[i].Close);
      ema = (price * multiplier) + (ema * (1 - multiplier));
    }
    
    return ema;
  }
  
  private calculateRSI(context: MarketContext, period: number): number | null {
    const bars = [...context.previousBars, context.currentBar];
    if (bars.length < period + 1) return null;
    
    let gains = 0;
    let losses = 0;
    
    // Calculate initial average gains and losses
    for (let i = 1; i <= period; i++) {
      const change = parseFloat(bars[i].Close) - parseFloat(bars[i-1].Close);
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
  
  private compareValues(actual: number, reference: number, operator: ComparisonOperator): boolean {
    switch (operator) {
      case 'gt': return actual > reference;
      case 'gte': return actual >= reference;
      case 'lt': return actual < reference;
      case 'lte': return actual <= reference;
      case 'eq': return Math.abs(actual - reference) < 0.0001; // Handle floating point comparison
      case 'neq': return Math.abs(actual - reference) >= 0.0001;
      case 'crosses_above': 
        // This would need previous values to detect crossover
        return actual > reference;
      case 'crosses_below':
        // This would need previous values to detect crossover  
        return actual < reference;
      default: return false;
    }
  }
}