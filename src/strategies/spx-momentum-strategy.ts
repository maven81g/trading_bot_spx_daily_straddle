// SPX Momentum Strategy - Options Trading based on MACD signals
// This strategy monitors $SPXW.X for MACD momentum and trades SPX options

import { BaseStrategy } from './base-strategy';
import { 
  StrategyConfig, 
  Signal, 
  MarketContext, 
  ConditionGroup, 
  TechnicalConditionConfig,
  PositionConditionConfig
} from '@/types/strategy';
import { MACDStudy } from '@/studies/macd';
import { Bar } from '@/types/tradestation';

interface SPXMomentumParams {
  macdFastPeriod: number;
  macdSlowPeriod: number;
  macdSignalPeriod: number;
  macdThreshold: number; // -2.0 threshold for entry consideration
  profitTarget: number; // $1.00 profit target
  optionDaysToExpiry: number; // Days to expiry for option selection
}

interface OptionPosition {
  symbol: string;
  entryPrice: number;
  entryTime: Date;
  strikePrice: number;
  expiryDate: Date;
  quantity: number;
  initialMacdHistogram: number;
}

export class SPXMomentumStrategy extends BaseStrategy {
  private macdStudy: MACDStudy;
  private spxSymbol = '$SPXW.X';
  private currentOptionPosition: OptionPosition | null = null;
  private previousMacdHistogram: number = 0;

  constructor(config: StrategyConfig) {
    super(config);
    
    const params = config.parameters as SPXMomentumParams;
    this.macdStudy = new MACDStudy(
      params.macdFastPeriod || 12,
      params.macdSlowPeriod || 26, 
      params.macdSignalPeriod || 9
    );
  }

  protected defineEntryConditions(): ConditionGroup {
    return {
      id: 'spx-momentum-entry',
      name: 'SPX Momentum Entry Conditions',
      operator: 'AND',
      conditions: [
        {
          id: 'macd-below-threshold',
          type: 'technical',
          name: 'MACD below -2',
          enabled: true,
          parameters: {
            indicator: 'macd',
            period: 0,
            operator: 'lt',
            value: (this.config.parameters as SPXMomentumParams).macdThreshold || -2.0
          }
        } as TechnicalConditionConfig,
        {
          id: 'macd-bullish-crossover',
          type: 'technical', 
          name: 'MACD Bullish Crossover',
          enabled: true,
          parameters: {
            indicator: 'macd',
            period: 0,
            operator: 'crosses_above',
            value: 0
          }
        } as TechnicalConditionConfig,
        {
          id: 'no-current-position',
          type: 'position',
          name: 'No Current Option Position',
          enabled: true,
          parameters: {
            positionType: 'has_position',
            operator: 'eq',
            value: 0
          }
        } as PositionConditionConfig
      ]
    };
  }

  protected defineExitConditions(): ConditionGroup {
    return {
      id: 'spx-momentum-exit',
      name: 'SPX Momentum Exit Conditions', 
      operator: 'AND',
      conditions: [
        {
          id: 'profit-target',
          type: 'position',
          name: 'Profit Target Reached',
          enabled: true,
          parameters: {
            positionType: 'unrealized_pnl',
            operator: 'gte',
            value: (this.config.parameters as SPXMomentumParams).profitTarget || 1.0,
            unit: 'dollars'
          }
        } as PositionConditionConfig,
        {
          id: 'momentum-shrinking',
          type: 'technical',
          name: 'MACD Momentum Shrinking',
          enabled: true,
          parameters: {
            indicator: 'macd',
            period: 0,
            operator: 'lt',
            value: 0 // Will be dynamically set to previous histogram value
          }
        } as TechnicalConditionConfig
      ]
    };
  }

  protected async calculateIndicators(context: MarketContext): Promise<Map<string, number | number[]>> {
    const indicators = new Map<string, number | number[]>();
    
    // Only process MACD for the SPX symbol
    if (context.symbol === this.spxSymbol) {
      this.macdStudy.addBar(context.currentBar);
      const macdValues = this.macdStudy.getCurrentValues();
      
      if (macdValues) {
        indicators.set('macd', macdValues.macd || 0);
        indicators.set('macd_signal', macdValues.signal || 0);
        indicators.set('macd_histogram', macdValues.histogram || 0);
        indicators.set('macd_crossover', macdValues.crossover === 'bullish' ? 1 : 
                     macdValues.crossover === 'bearish' ? -1 : 0);
      }
    }
    
    return indicators;
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
      // Entry Logic: MACD was below -2 and now has bullish crossover
      if (!this.currentOptionPosition && macdCrossover === 1 && macdValue < (this.config.parameters as SPXMomentumParams).macdThreshold) {
        const optionSymbol = await this.findClosestITMCallOption(context);
        if (optionSymbol) {
          const signal: Signal = {
            id: `spx_momentum_entry_${Date.now()}`,
            symbol: optionSymbol,
            type: 'BUY',
            timestamp: new Date(),
            price: parseFloat(context.currentBar.Close), // This will be updated with option price
            quantity: 1, // Start with 1 contract
            confidence: 0.85,
            reason: `SPX Momentum Entry: MACD bullish crossover after being below ${(this.config.parameters as SPXMomentumParams).macdThreshold}`,
            metadata: {
              strategyId: this.id,
              underlyingSymbol: this.spxSymbol,
              macdValue,
              macdHistogram,
              spxPrice: parseFloat(context.currentBar.Close)
            }
          };
          signals.push(signal);
        }
      }
      
      // Exit Logic: $1 profit target AND momentum shrinking
      if (this.currentOptionPosition) {
        const currentPrice = parseFloat(context.currentBar.Close); // This should be option price
        const profitTarget = (this.config.parameters as SPXMomentumParams).profitTarget || 1.0;
        const unrealizedProfit = (currentPrice - this.currentOptionPosition.entryPrice) * this.currentOptionPosition.quantity * 100; // Options are 100 shares per contract
        
        const momentumShrinking = macdHistogram < this.previousMacdHistogram;
        
        // Exit only when BOTH conditions are met: $1 profit AND momentum shrinking
        if (unrealizedProfit >= profitTarget && momentumShrinking) {
          const signal: Signal = {
            id: `spx_momentum_exit_${Date.now()}`,
            symbol: this.currentOptionPosition.symbol,
            type: 'SELL',
            timestamp: new Date(),
            price: currentPrice,
            quantity: this.currentOptionPosition.quantity,
            confidence: 0.9,
            reason: 'Profit target reached AND MACD momentum shrinking',
            metadata: {
              strategyId: this.id,
              unrealizedProfit,
              macdHistogram,
              previousMacdHistogram: this.previousMacdHistogram
            }
          };
          signals.push(signal);
        }
      }
      
      // Store previous histogram for momentum comparison
      this.previousMacdHistogram = macdHistogram;
      
    } catch (error) {
      this.logger.error('Error generating SPX momentum signals:', error);
    }
    
    return signals;
  }

  private async findClosestITMCallOption(context: MarketContext): Promise<string | null> {
    try {
      const spxPrice = parseFloat(context.currentBar.Close);
      const params = this.config.parameters as SPXMomentumParams;
      const daysToExpiry = params.optionDaysToExpiry || 7; // Default to weekly options
      
      // Calculate target expiry date
      const targetExpiry = new Date();
      targetExpiry.setDate(targetExpiry.getDate() + daysToExpiry);
      
      // Find closest Friday for weekly SPX options (or next available expiry)
      while (targetExpiry.getDay() !== 5) { // 5 = Friday
        targetExpiry.setDate(targetExpiry.getDate() + 1);
      }
      
      // Find closest ITM strike (round down to nearest $5 increment for SPX)
      const strikePrice = Math.floor(spxPrice / 5) * 5;
      
      // Construct SPX option symbol: SPXW YYMMDDCSSSS
      const optionSymbol = this.constructSPXOptionSymbol(targetExpiry, strikePrice, 'C');
      
      this.logger.info(`Selected SPX call option: ${optionSymbol} with strike ${strikePrice} for SPX at ${spxPrice}`);
      
      return optionSymbol;
    } catch (error) {
      this.logger.error('Error finding closest ITM call option:', error);
      return null;
    }
  }

  private constructSPXOptionSymbol(expiryDate: Date, strikePrice: number, optionType: 'C' | 'P'): string {
    // Format: SPXW YYMMDDCssss (e.g., SPXW 250729C6370)
    const year = expiryDate.getFullYear().toString().slice(-2);
    const month = (expiryDate.getMonth() + 1).toString().padStart(2, '0');
    const day = expiryDate.getDate().toString().padStart(2, '0');
    const strike = Math.round(strikePrice).toString();
    
    return `SPXW ${year}${month}${day}${optionType}${strike}`;
  }

  async onOrderFilled(order: any, context: MarketContext): Promise<void> {
    await super.onOrderFilled(order, context);
    
    try {
      const symbol = order.Symbol;
      const quantity = parseFloat(order.Quantity || '0');
      const price = parseFloat(order.FilledPrice || '0');
      const side = order.TradeAction;
      
      // Track option position
      if (side === 'BUY' && symbol.startsWith('SPXW')) {
        // Parse option details from symbol
        const strikeMatch = symbol.match(/[CP](\d+)$/);
        const expiryMatch = symbol.match(/(\d{6})[CP]/);
        
        if (strikeMatch && expiryMatch) {
          const strikePrice = parseInt(strikeMatch[1]);
          const expiryStr = expiryMatch[1];
          const expiryDate = new Date(
            2000 + parseInt(expiryStr.slice(0, 2)), // Year
            parseInt(expiryStr.slice(2, 4)) - 1,    // Month (0-based)
            parseInt(expiryStr.slice(4, 6))         // Day
          );
          
          this.currentOptionPosition = {
            symbol,
            entryPrice: price,
            entryTime: new Date(),
            strikePrice,
            expiryDate,
            quantity,
            initialMacdHistogram: this.previousMacdHistogram
          };
          
          this.logger.info(`Opened SPX option position: ${symbol} at $${price}`);
        }
      } else if (side === 'SELL' && this.currentOptionPosition?.symbol === symbol) {
        // Close position
        const profit = (price - this.currentOptionPosition.entryPrice) * quantity * 100;
        this.logger.info(`Closed SPX option position: ${symbol} at $${price}, Profit: $${profit.toFixed(2)}`);
        this.currentOptionPosition = null;
      }
    } catch (error) {
      this.logger.error('Error processing SPX option order fill:', error);
    }
  }

  protected getMaxLookbackPeriod(): number {
    const params = this.config.parameters as SPXMomentumParams;
    return Math.max(params.macdSlowPeriod || 26, 50); // Ensure enough data for MACD calculation
  }
}