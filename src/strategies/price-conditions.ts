// Price-based Trading Conditions

import { PriceConditionConfig, MarketContext, ICondition } from '@/types/strategy';
import { ConditionEvaluator } from './condition-evaluator';

export class PriceConditions {
  
  async evaluate(condition: PriceConditionConfig, context: MarketContext): Promise<boolean> {
    const { priceType, operator, value, referenceType, lookbackPeriod } = condition.parameters;
    
    try {
      const currentPrice = this.getCurrentPrice(priceType, context);
      const referenceValue = await this.getReferenceValue(
        currentPrice, 
        referenceType, 
        value, 
        lookbackPeriod, 
        context
      );

      return this.compareValues(currentPrice, referenceValue, operator, context);
    } catch (error) {
      console.error(`Error evaluating price condition ${condition.id}:`, error);
      return false;
    }
  }

  private getCurrentPrice(priceType: string, context: MarketContext): number {
    const bar = context.currentBar;
    
    switch (priceType) {
      case 'open':
        return parseFloat(bar.Open);
      case 'high':
        return parseFloat(bar.High);
      case 'low':
        return parseFloat(bar.Low);
      case 'close':
        return parseFloat(bar.Close);
      case 'typical':
        // (High + Low + Close) / 3
        return (parseFloat(bar.High) + parseFloat(bar.Low) + parseFloat(bar.Close)) / 3;
      case 'weighted':
        // (High + Low + Close + Close) / 4
        return (parseFloat(bar.High) + parseFloat(bar.Low) + 2 * parseFloat(bar.Close)) / 4;
      default:
        return parseFloat(bar.Close);
    }
  }

  private async getReferenceValue(
    currentPrice: number,
    referenceType: string,
    value: number,
    lookbackPeriod: number | undefined,
    context: MarketContext
  ): Promise<number> {
    switch (referenceType) {
      case 'absolute':
        return value;
      
      case 'percentage':
        return currentPrice * (1 + value / 100);
      
      case 'previous_bar':
        if (context.previousBars.length > 0) {
          const previousBar = context.previousBars[context.previousBars.length - 1];
          return parseFloat(previousBar.Close);
        }
        return currentPrice;
      
      case 'moving_average':
        return this.calculateMovingAverage(context, lookbackPeriod || 20);
      
      default:
        return value;
    }
  }

  private calculateMovingAverage(context: MarketContext, period: number): number {
    const bars = [...context.previousBars, context.currentBar];
    
    if (bars.length < period) {
      // Not enough data, use all available bars
      period = bars.length;
    }
    
    const relevantBars = bars.slice(-period);
    const sum = relevantBars.reduce((acc, bar) => acc + parseFloat(bar.Close), 0);
    
    return sum / period;
  }

  private compareValues(
    currentPrice: number,
    referenceValue: number,
    operator: string,
    context: MarketContext
  ): boolean {
    switch (operator) {
      case 'gt':
        return currentPrice > referenceValue;
      
      case 'gte':
        return currentPrice >= referenceValue;
      
      case 'lt':
        return currentPrice < referenceValue;
      
      case 'lte':
        return currentPrice <= referenceValue;
      
      case 'eq':
        return Math.abs(currentPrice - referenceValue) < 0.01; // Allow small tolerance
      
      case 'neq':
        return Math.abs(currentPrice - referenceValue) >= 0.01;
      
      case 'crosses_above':
        return this.checkCrossAbove(currentPrice, referenceValue, context);
      
      case 'crosses_below':
        return this.checkCrossBelow(currentPrice, referenceValue, context);
      
      default:
        console.warn(`Unknown price comparison operator: ${operator}`);
        return false;
    }
  }

  private checkCrossAbove(currentPrice: number, referenceValue: number, context: MarketContext): boolean {
    if (context.previousBars.length === 0) return false;
    
    const previousBar = context.previousBars[context.previousBars.length - 1];
    const previousPrice = parseFloat(previousBar.Close);
    
    return previousPrice <= referenceValue && currentPrice > referenceValue;
  }

  private checkCrossBelow(currentPrice: number, referenceValue: number, context: MarketContext): boolean {
    if (context.previousBars.length === 0) return false;
    
    const previousBar = context.previousBars[context.previousBars.length - 1];
    const previousPrice = parseFloat(previousBar.Close);
    
    return previousPrice >= referenceValue && currentPrice < referenceValue;
  }
}

// Specific Price Condition Classes
export class PriceAboveCondition implements ICondition {
  id: string;
  name: string;
  description: string;
  private threshold: number;

  constructor(id: string, threshold: number) {
    this.id = id;
    this.threshold = threshold;
    this.name = `Price Above ${threshold}`;
    this.description = `Current price is above ${threshold}`;
  }

  evaluate(context: MarketContext): boolean {
    const currentPrice = parseFloat(context.currentBar.Close);
    return currentPrice > this.threshold;
  }

  getRequiredData(): string[] {
    return ['bars'];
  }
}

export class PriceBelowCondition implements ICondition {
  id: string;
  name: string;
  description: string;
  private threshold: number;

  constructor(id: string, threshold: number) {
    this.id = id;
    this.threshold = threshold;
    this.name = `Price Below ${threshold}`;
    this.description = `Current price is below ${threshold}`;
  }

  evaluate(context: MarketContext): boolean {
    const currentPrice = parseFloat(context.currentBar.Close);
    return currentPrice < this.threshold;
  }

  getRequiredData(): string[] {
    return ['bars'];
  }
}

export class PriceCrossesAboveMACondition implements ICondition {
  id: string;
  name: string;
  description: string;
  private period: number;

  constructor(id: string, period: number = 20) {
    this.id = id;
    this.period = period;
    this.name = `Price Crosses Above MA(${period})`;
    this.description = `Price crosses above ${period}-period moving average`;
  }

  evaluate(context: MarketContext): boolean {
    if (context.previousBars.length < this.period) return false;

    const currentPrice = parseFloat(context.currentBar.Close);
    const previousPrice = parseFloat(context.previousBars[context.previousBars.length - 1].Close);

    const currentMA = this.calculateMA(context, this.period, true);
    const previousMA = this.calculateMA(context, this.period, false);

    return previousPrice <= previousMA && currentPrice > currentMA;
  }

  private calculateMA(context: MarketContext, period: number, includeCurrent: boolean): number {
    const bars = includeCurrent ? 
      [...context.previousBars, context.currentBar] : 
      context.previousBars;
    
    const relevantBars = bars.slice(-period);
    const sum = relevantBars.reduce((acc, bar) => acc + parseFloat(bar.Close), 0);
    
    return sum / relevantBars.length;
  }

  getRequiredData(): string[] {
    return ['bars'];
  }
}

export class PriceCrossesBelowMACondition implements ICondition {
  id: string;
  name: string;
  description: string;
  private period: number;

  constructor(id: string, period: number = 20) {
    this.id = id;
    this.period = period;
    this.name = `Price Crosses Below MA(${period})`;
    this.description = `Price crosses below ${period}-period moving average`;
  }

  evaluate(context: MarketContext): boolean {
    if (context.previousBars.length < this.period) return false;

    const currentPrice = parseFloat(context.currentBar.Close);
    const previousPrice = parseFloat(context.previousBars[context.previousBars.length - 1].Close);

    const currentMA = this.calculateMA(context, this.period, true);
    const previousMA = this.calculateMA(context, this.period, false);

    return previousPrice >= previousMA && currentPrice < currentMA;
  }

  private calculateMA(context: MarketContext, period: number, includeCurrent: boolean): number {
    const bars = includeCurrent ? 
      [...context.previousBars, context.currentBar] : 
      context.previousBars;
    
    const relevantBars = bars.slice(-period);
    const sum = relevantBars.reduce((acc, bar) => acc + parseFloat(bar.Close), 0);
    
    return sum / relevantBars.length;
  }

  getRequiredData(): string[] {
    return ['bars'];
  }
}

export class PriceInRangeCondition implements ICondition {
  id: string;
  name: string;
  description: string;
  private minPrice: number;
  private maxPrice: number;

  constructor(id: string, minPrice: number, maxPrice: number) {
    this.id = id;
    this.minPrice = minPrice;
    this.maxPrice = maxPrice;
    this.name = `Price In Range ${minPrice}-${maxPrice}`;
    this.description = `Current price is between ${minPrice} and ${maxPrice}`;
  }

  evaluate(context: MarketContext): boolean {
    const currentPrice = parseFloat(context.currentBar.Close);
    return currentPrice >= this.minPrice && currentPrice <= this.maxPrice;
  }

  getRequiredData(): string[] {
    return ['bars'];
  }
}

export class PriceGapCondition implements ICondition {
  id: string;
  name: string;
  description: string;
  private gapType: 'up' | 'down' | 'any';
  private minGapPercent: number;

  constructor(id: string, gapType: 'up' | 'down' | 'any' = 'any', minGapPercent: number = 1) {
    this.id = id;
    this.gapType = gapType;
    this.minGapPercent = minGapPercent;
    this.name = `Price Gap ${gapType.toUpperCase()} ${minGapPercent}%`;
    this.description = `Price gaps ${gapType} by at least ${minGapPercent}%`;
  }

  evaluate(context: MarketContext): boolean {
    if (context.previousBars.length === 0) return false;

    const currentOpen = parseFloat(context.currentBar.Open);
    const previousClose = parseFloat(context.previousBars[context.previousBars.length - 1].Close);
    
    const gapPercent = ((currentOpen - previousClose) / previousClose) * 100;
    const absGapPercent = Math.abs(gapPercent);

    if (absGapPercent < this.minGapPercent) return false;

    switch (this.gapType) {
      case 'up':
        return gapPercent > 0;
      case 'down':
        return gapPercent < 0;
      case 'any':
        return true;
      default:
        return false;
    }
  }

  getRequiredData(): string[] {
    return ['bars'];
  }
}

export class PricePercentChangeCondition implements ICondition {
  id: string;
  name: string;
  description: string;
  private lookbackPeriod: number;
  private minChangePercent: number;
  private changeDirection: 'up' | 'down' | 'any';

  constructor(
    id: string, 
    lookbackPeriod: number = 1, 
    minChangePercent: number = 5,
    changeDirection: 'up' | 'down' | 'any' = 'any'
  ) {
    this.id = id;
    this.lookbackPeriod = lookbackPeriod;
    this.minChangePercent = minChangePercent;
    this.changeDirection = changeDirection;
    this.name = `Price Change ${changeDirection.toUpperCase()} ${minChangePercent}%`;
    this.description = `Price changes ${changeDirection} by at least ${minChangePercent}% over ${lookbackPeriod} periods`;
  }

  evaluate(context: MarketContext): boolean {
    if (context.previousBars.length < this.lookbackPeriod) return false;

    const currentPrice = parseFloat(context.currentBar.Close);
    const lookbackIndex = context.previousBars.length - this.lookbackPeriod;
    const lookbackPrice = parseFloat(context.previousBars[lookbackIndex].Close);
    
    const changePercent = ((currentPrice - lookbackPrice) / lookbackPrice) * 100;
    const absChangePercent = Math.abs(changePercent);

    if (absChangePercent < this.minChangePercent) return false;

    switch (this.changeDirection) {
      case 'up':
        return changePercent > 0;
      case 'down':
        return changePercent < 0;
      case 'any':
        return true;
      default:
        return false;
    }
  }

  getRequiredData(): string[] {
    return ['bars'];
  }
}