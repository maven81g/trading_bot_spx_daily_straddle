// Condition Evaluator - Evaluates trading conditions

import {
  ConditionGroup,
  ConditionConfig,
  MarketContext,
  LogicalOperator,
  PriceConditionConfig,
  VolumeConditionConfig,
  TechnicalConditionConfig,
  TimeConditionConfig,
  PositionConditionConfig,
  ComparisonOperator
} from '../types/strategy';
import { PriceConditions } from './price-conditions';
import { VolumeConditions } from './volume-conditions';
import { TechnicalConditions } from './technical-conditions';
import { TimeConditions } from './time-conditions';
// import { PositionConditions } from './position-conditions'; // Temporarily disabled

export class ConditionEvaluator {
  private priceConditions: PriceConditions;
  private volumeConditions: VolumeConditions;
  private technicalConditions: TechnicalConditions;
  private timeConditions: TimeConditions;
  // private positionConditions: PositionConditions; // Temporarily disabled

  constructor() {
    this.priceConditions = new PriceConditions();
    this.volumeConditions = new VolumeConditions();
    this.technicalConditions = new TechnicalConditions();
    this.timeConditions = new TimeConditions();
    // this.positionConditions = new PositionConditions(); // Temporarily disabled
  }

  async evaluate(group: ConditionGroup, context: MarketContext): Promise<boolean> {
    if (!group.conditions || group.conditions.length === 0) {
      return true; // Empty condition group is considered true
    }

    const results: boolean[] = [];

    for (const condition of group.conditions) {
      let result: boolean;

      if ('operator' in condition) {
        // It's a nested ConditionGroup
        result = await this.evaluate(condition as ConditionGroup, context);
      } else {
        // It's a ConditionConfig
        result = await this.evaluateCondition(condition as ConditionConfig, context);
      }

      results.push(result);
    }

    return this.combineResults(results, group.operator);
  }

  private async evaluateCondition(condition: ConditionConfig, context: MarketContext): Promise<boolean> {
    if (!condition.enabled) {
      return true; // Disabled conditions are considered true
    }

    try {
      switch (condition.type) {
        case 'price':
          return await this.priceConditions.evaluate(condition as PriceConditionConfig, context);
        
        case 'volume':
          return await this.volumeConditions.evaluate(condition as VolumeConditionConfig, context);
        
        case 'technical':
          return await this.technicalConditions.evaluate(condition as TechnicalConditionConfig, context);
        
        case 'time':
          return await this.timeConditions.evaluate(condition as TimeConditionConfig, context);
        
        case 'position':
          // return await this.positionConditions.evaluate(condition as PositionConditionConfig, context); // Temporarily disabled
          console.warn('Position conditions temporarily disabled for compilation');
          return false;
        
        default:
          console.warn(`Unknown condition type: ${condition.type}`);
          return false;
      }
    } catch (error) {
      console.error(`Error evaluating condition ${condition.id}:`, error);
      return false;
    }
  }

  private combineResults(results: boolean[], operator: LogicalOperator): boolean {
    if (results.length === 0) return true;

    switch (operator) {
      case 'AND':
        return results.every(result => result);
      
      case 'OR':
        return results.some(result => result);
      
      case 'NOT':
        // For NOT operator, we negate the first result
        return !results[0];
      
      default:
        console.warn(`Unknown logical operator: ${operator}`);
        return false;
    }
  }

  // Utility method for comparing values
  static compareValues(value1: number, value2: number, operator: ComparisonOperator): boolean {
    switch (operator) {
      case 'gt':
        return value1 > value2;
      case 'gte':
        return value1 >= value2;
      case 'lt':
        return value1 < value2;
      case 'lte':
        return value1 <= value2;
      case 'eq':
        return Math.abs(value1 - value2) < Number.EPSILON;
      case 'neq':
        return Math.abs(value1 - value2) >= Number.EPSILON;
      case 'between':
        // For 'between', value2 should be an array [min, max]
        console.warn('Between operator requires special handling with min/max values');
        return false;
      case 'outside':
        // For 'outside', value2 should be an array [min, max]
        console.warn('Outside operator requires special handling with min/max values');
        return false;
      case 'crosses_above':
      case 'crosses_below':
        // These require historical data and should be handled in specific condition classes
        console.warn('Cross operators require historical data handling');
        return false;
      default:
        console.warn(`Unknown comparison operator: ${operator}`);
        return false;
    }
  }

  // Helper method for range comparisons
  static compareRange(value: number, range: [number, number], operator: 'between' | 'outside'): boolean {
    const [min, max] = range;
    
    switch (operator) {
      case 'between':
        return value >= min && value <= max;
      case 'outside':
        return value < min || value > max;
      default:
        return false;
    }
  }

  // Helper method for cross comparisons (requires historical data)
  static checkCross(
    currentValue: number,
    previousValue: number,
    referenceValue: number,
    operator: 'crosses_above' | 'crosses_below'
  ): boolean {
    switch (operator) {
      case 'crosses_above':
        return previousValue <= referenceValue && currentValue > referenceValue;
      case 'crosses_below':
        return previousValue >= referenceValue && currentValue < referenceValue;
      default:
        return false;
    }
  }

  // Method to get all required data dependencies for a condition group
  getRequiredData(group: ConditionGroup): string[] {
    const requiredData = new Set<string>();

    for (const condition of group.conditions) {
      if ('operator' in condition) {
        // It's a nested ConditionGroup
        const nestedData = this.getRequiredData(condition as ConditionGroup);
        nestedData.forEach(data => requiredData.add(data));
      } else {
        // It's a ConditionConfig
        const conditionData = this.getConditionRequiredData(condition as ConditionConfig);
        conditionData.forEach(data => requiredData.add(data));
      }
    }

    return Array.from(requiredData);
  }

  private getConditionRequiredData(condition: ConditionConfig): string[] {
    const data: string[] = [];

    switch (condition.type) {
      case 'price':
        data.push('bars', 'quotes');
        break;
      
      case 'volume':
        data.push('bars');
        break;
      
      case 'technical':
        data.push('bars');
        const techCondition = condition as TechnicalConditionConfig;
        data.push(`indicator:${techCondition.parameters.indicator}`);
        break;
      
      case 'time':
        data.push('timestamp');
        break;
      
      case 'position':
        data.push('positions');
        break;
      
      default:
        break;
    }

    return data;
  }

  // Method to validate condition configuration
  validateCondition(condition: ConditionConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Basic validation
    if (!condition.id) {
      errors.push('Condition ID is required');
    }

    if (!condition.type) {
      errors.push('Condition type is required');
    }

    if (!condition.parameters) {
      errors.push('Condition parameters are required');
    }

    // Type-specific validation
    switch (condition.type) {
      case 'price':
        this.validatePriceCondition(condition as PriceConditionConfig, errors);
        break;
      
      case 'volume':
        this.validateVolumeCondition(condition as VolumeConditionConfig, errors);
        break;
      
      case 'technical':
        this.validateTechnicalCondition(condition as TechnicalConditionConfig, errors);
        break;
      
      case 'time':
        this.validateTimeCondition(condition as TimeConditionConfig, errors);
        break;
      
      case 'position':
        this.validatePositionCondition(condition as PositionConditionConfig, errors);
        break;
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  private validatePriceCondition(condition: PriceConditionConfig, errors: string[]): void {
    const params = condition.parameters;
    
    if (!params.priceType) {
      errors.push('Price type is required');
    }
    
    if (!params.operator) {
      errors.push('Comparison operator is required');
    }
    
    if (params.value === undefined || params.value === null) {
      errors.push('Comparison value is required');
    }
    
    if (!params.referenceType) {
      errors.push('Reference type is required');
    }
  }

  private validateVolumeCondition(condition: VolumeConditionConfig, errors: string[]): void {
    const params = condition.parameters;
    
    if (!params.operator) {
      errors.push('Comparison operator is required');
    }
    
    if (params.value === undefined || params.value === null) {
      errors.push('Comparison value is required');
    }
    
    if (!params.referenceType) {
      errors.push('Reference type is required');
    }
  }

  private validateTechnicalCondition(condition: TechnicalConditionConfig, errors: string[]): void {
    const params = condition.parameters;
    
    if (!params.indicator) {
      errors.push('Technical indicator is required');
    }
    
    if (!params.period || params.period <= 0) {
      errors.push('Valid period is required');
    }
    
    if (!params.operator) {
      errors.push('Comparison operator is required');
    }
    
    if (params.value === undefined || params.value === null) {
      errors.push('Comparison value is required');
    }
  }

  private validateTimeCondition(condition: TimeConditionConfig, errors: string[]): void {
    const params = condition.parameters;
    
    if (!params.timeType) {
      errors.push('Time type is required');
    }
    
    // Additional validation based on time type
    if (params.timeType === 'time_of_day') {
      if (!params.startTime || !params.endTime) {
        errors.push('Start time and end time are required for time_of_day conditions');
      }
    }
  }

  private validatePositionCondition(condition: PositionConditionConfig, errors: string[]): void {
    const params = condition.parameters;
    
    if (!params.positionType) {
      errors.push('Position type is required');
    }
  }
}