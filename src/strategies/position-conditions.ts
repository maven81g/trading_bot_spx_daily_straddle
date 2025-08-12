// Position-based Conditions for Strategy Evaluation

import { PositionConditionConfig, MarketContext, ComparisonOperator } from '@/types/strategy';

export class PositionConditions {
  
  /**
   * Evaluate position-based conditions
   */
  evaluate(config: PositionConditionConfig, context: MarketContext): boolean {
    try {
      const { positionType, symbol, operator, value, unit } = config.parameters;
      
      switch (positionType) {
        case 'has_position':
          return this.evaluateHasPosition(context, symbol);
          
        case 'position_size':
          return this.evaluatePositionSize(context, symbol, operator!, value!, unit);
          
        case 'unrealized_pnl':
          return this.evaluateUnrealizedPnL(context, symbol, operator!, value!, unit);
          
        case 'position_age':
          return this.evaluatePositionAge(context, symbol, operator!, value!, unit);
          
        default:
          return true;
      }
      
    } catch (error) {
      console.warn('Position condition evaluation error:', error);
      return false;
    }
  }
  
  private evaluateHasPosition(context: MarketContext, symbol?: string): boolean {
    if (!symbol) {
      // Check if any positions exist
      return context.positions.length > 0;
    }
    
    // Check for specific symbol position
    return context.positions.some(pos => pos.Symbol === symbol && parseFloat(pos.Quantity) !== 0);
  }
  
  private evaluatePositionSize(
    context: MarketContext, 
    symbol: string | undefined, 
    operator: ComparisonOperator, 
    value: number,
    unit?: string
  ): boolean {
    const position = symbol 
      ? context.positions.find(pos => pos.Symbol === symbol)
      : context.positions[0]; // First position if no symbol specified
      
    if (!position) return false;
    
    let positionSize = Math.abs(parseFloat(position.Quantity));
    
    // Convert to appropriate unit
    if (unit === 'dollars') {
      positionSize = positionSize * position.AveragePrice;
    }
    // Default is shares
    
    return this.compareValues(positionSize, value, operator);
  }
  
  private evaluateUnrealizedPnL(
    context: MarketContext,
    symbol: string | undefined,
    operator: ComparisonOperator,
    value: number,
    unit?: string
  ): boolean {
    const position = symbol
      ? context.positions.find(pos => pos.Symbol === symbol)
      : context.positions[0];
      
    if (!position) return false;
    
    let pnl = position.UnrealizedPnL || 0;
    
    // Convert to percentage if needed
    if (unit === 'percentage') {
      const positionValue = parseFloat(position.Quantity) * position.AveragePrice;
      pnl = positionValue !== 0 ? (pnl / positionValue) * 100 : 0;
    }
    
    return this.compareValues(pnl, value, operator);
  }
  
  private evaluatePositionAge(
    context: MarketContext,
    symbol: string | undefined, 
    operator: ComparisonOperator,
    value: number,
    unit?: string
  ): boolean {
    // This would need additional position tracking data
    // For now, return true as placeholder
    return true;
  }
  
  private compareValues(actual: number, reference: number, operator: ComparisonOperator): boolean {
    switch (operator) {
      case 'gt': return actual > reference;
      case 'gte': return actual >= reference;
      case 'lt': return actual < reference;
      case 'lte': return actual <= reference;
      case 'eq': return Math.abs(actual - reference) < 0.0001;
      case 'neq': return Math.abs(actual - reference) >= 0.0001;
      default: return false;
    }
  }
}