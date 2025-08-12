// Volume-based Conditions for Strategy Evaluation

import { VolumeConditionConfig, MarketContext, ComparisonOperator } from '@/types/strategy';

export class VolumeConditions {
  
  /**
   * Evaluate volume-based conditions
   */
  evaluate(config: VolumeConditionConfig, context: MarketContext): boolean {
    try {
      const currentVolume = parseInt(context.currentBar.TotalVolume);
      const { operator, value, referenceType, lookbackPeriod } = config.parameters;
      
      let referenceValue = value;
      
      // Calculate reference value based on type
      switch (referenceType) {
        case 'absolute':
          referenceValue = value;
          break;
          
        case 'percentage':
          // Get average volume and apply percentage
          const avgVolume = this.calculateAverageVolume(context, lookbackPeriod || 20);
          referenceValue = avgVolume * (value / 100);
          break;
          
        case 'average':
          referenceValue = this.calculateAverageVolume(context, lookbackPeriod || 20);
          break;
          
        case 'previous_bar':
          if (context.previousBars.length > 0) {
            const prevBar = context.previousBars[context.previousBars.length - 1];
            referenceValue = parseInt(prevBar.TotalVolume);
          }
          break;
      }
      
      return this.compareValues(currentVolume, referenceValue, operator);
      
    } catch (error) {
      console.warn('Volume condition evaluation error:', error);
      return false;
    }
  }
  
  private calculateAverageVolume(context: MarketContext, period: number): number {
    const bars = [...context.previousBars, context.currentBar];
    const recentBars = bars.slice(-period);
    
    if (recentBars.length === 0) return 0;
    
    const totalVolume = recentBars.reduce((sum, bar) => {
      return sum + parseInt(bar.TotalVolume);
    }, 0);
    
    return totalVolume / recentBars.length;
  }
  
  private compareValues(actual: number, reference: number, operator: ComparisonOperator): boolean {
    switch (operator) {
      case 'gt': return actual > reference;
      case 'gte': return actual >= reference;
      case 'lt': return actual < reference;
      case 'lte': return actual <= reference;
      case 'eq': return actual === reference;
      case 'neq': return actual !== reference;
      case 'between': return false; // Would need two values
      case 'outside': return false; // Would need two values
      default: return false;
    }
  }
}