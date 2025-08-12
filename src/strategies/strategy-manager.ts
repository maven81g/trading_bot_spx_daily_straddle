import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { StrategyConfig, Signal, MarketContext, StrategyState } from '../types/strategy';
import { Bar, Quote } from '../types/tradestation';
import { createLogger } from '../utils/logger';

// Import strategy classes
import { BaseStrategy } from './base-strategy';
import { SPXBacktestStrategy } from './spx-backtest-strategy';

export class StrategyManager extends EventEmitter {
  private logger: Logger;
  private strategies: Map<string, BaseStrategy> = new Map();
  private strategyStates: Map<string, StrategyState> = new Map();

  constructor() {
    super();
    this.logger = createLogger('StrategyManager');
  }

  private createStrategyInstance(config: StrategyConfig): BaseStrategy {
    switch (config.type) {
      case 'SPX_BACKTEST':
        return new SPXBacktestStrategy(config);
      default:
        throw new Error(`Unknown strategy type: ${config.type}`);
    }
  }

  async addStrategy(config: StrategyConfig): Promise<void> {
    try {
      this.logger.info(`Adding strategy: ${config.name} (${config.type})`);
      
      // Create strategy instance
      const strategyInstance = this.createStrategyInstance(config);
      
      // Initialize strategy
      await strategyInstance.initialize();
      
      this.strategies.set(config.id, strategyInstance);
      this.strategyStates.set(config.id, 'ACTIVE');
      
      this.logger.info(`Strategy ${config.name} added successfully`);
      
    } catch (error) {
      this.logger.error(`Failed to add strategy ${config.name}:`, error);
      throw error;
    }
  }

  async removeStrategy(strategyId: string): Promise<void> {
    const strategy = this.strategies.get(strategyId);
    if (strategy) {
      await strategy.shutdown();
      this.strategies.delete(strategyId);
      this.strategyStates.delete(strategyId);
      this.logger.info(`Strategy ${strategyId} removed`);
    }
  }

  async onBar(symbol: string, bar: Bar, context: MarketContext): Promise<void> {
    try {
      for (const [strategyId, strategy] of this.strategies.entries()) {
        if (!strategy.config.enabled || !strategy.config.symbols.includes(symbol)) {
          continue;
        }

        // Process bar data with strategy
        const signals = await strategy.onBar(bar, context);
        
        if (signals.length > 0) {
          this.emit('signal', { strategyId, signals });
        }
      }
    } catch (error) {
      this.logger.error('Error processing bar data:', error);
    }
  }

  async onQuote(symbol: string, quote: Quote, context: MarketContext): Promise<void> {
    try {
      for (const [strategyId, strategy] of this.strategies.entries()) {
        if (!strategy.config.enabled || !strategy.config.symbols.includes(symbol)) {
          continue;
        }

        // Process quote data with strategy
        await strategy.onQuote(quote, context);
      }
    } catch (error) {
      this.logger.error('Error processing quote data:', error);
    }
  }

  async onOrderFilled(symbol: string, order: any, context: MarketContext): Promise<void> {
    try {
      for (const [strategyId, strategy] of this.strategies.entries()) {
        if (!strategy.config.enabled || !strategy.config.symbols.includes(symbol)) {
          continue;
        }

        // Notify strategy of order fill
        await strategy.onOrderFilled(order, context);
      }
    } catch (error) {
      this.logger.error('Error processing order fill:', error);
    }
  }

  getStrategy(strategyId: string): BaseStrategy | undefined {
    return this.strategies.get(strategyId);
  }

  getStrategies(): Map<string, BaseStrategy> {
    return new Map(this.strategies);
  }

  getStrategyState(strategyId: string): StrategyState | undefined {
    return this.strategyStates.get(strategyId);
  }

  getStrategyStates(): Map<string, StrategyState> {
    return new Map(this.strategyStates);
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down strategy manager...');
    
    for (const [strategyId, strategy] of this.strategies.entries()) {
      try {
        await strategy.shutdown();
      } catch (error) {
        this.logger.error(`Error shutting down strategy ${strategyId}:`, error);
      }
    }
    
    this.strategies.clear();
    this.strategyStates.clear();
    this.removeAllListeners();
    
    this.logger.info('Strategy manager shutdown complete');
  }
}