// TradeStation HTTP Streaming Handler
// Uses HTTP streaming instead of WebSocket

import axios, { AxiosResponse } from 'axios';
import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { 
  TradeStationConfig,
  AuthToken,
  Bar,
  Quote
} from '../types/tradestation';
import { createLogger } from '../utils/logger';

export interface StreamingSubscription {
  id: string;
  type: 'bars' | 'quotes';
  symbols: string[];
  active: boolean;
  abortController?: AbortController;
  parameters?: any; // Store original subscription parameters for reconnection
  lastActivity?: number; // Track last activity timestamp
}

export class TradeStationHttpStreaming extends EventEmitter {
  private config: TradeStationConfig;
  private logger: Logger;
  private subscriptions: Map<string, StreamingSubscription> = new Map();
  private authToken: AuthToken | null = null;

  constructor(config: TradeStationConfig) {
    super();
    this.config = config;
    this.logger = createLogger('TradeStationHttpStreaming');
  }

  setAuthToken(token: AuthToken): void {
    this.authToken = token;
  }

  // Subscribe to bar streaming using HTTP streaming
  async subscribeToBars(params: {
    symbol: string;
    interval: number;
    unit: 'Minute' | 'Daily' | 'Weekly' | 'Monthly';
    subscriptionId?: string;
  }): Promise<string> {
    const subscriptionId = params.subscriptionId || `bars_${params.symbol}_${Date.now()}`;
    
    if (!this.authToken) {
      throw new Error('Authentication token required for streaming');
    }

    this.logger.info(`📊 Starting HTTP streaming for bars: ${params.symbol}`);

    // Build streaming URL - HTTP streaming endpoint (URL encode symbol)
    const encodedSymbol = encodeURIComponent(params.symbol);
    const streamUrl = `${this.config.baseUrl}/marketdata/stream/barcharts/${encodedSymbol}?interval=${params.interval}&unit=${params.unit.toLowerCase()}`;
    
    const abortController = new AbortController();
    
    const subscription: StreamingSubscription = {
      id: subscriptionId,
      type: 'bars',
      symbols: [params.symbol],
      active: true,
      abortController,
      parameters: params
    };

    this.subscriptions.set(subscriptionId, subscription);

    try {
      // Start HTTP streaming request
      const response = await axios.get(streamUrl, {
        headers: {
          'Authorization': `Bearer ${this.authToken.access_token}`,
          'Accept': 'application/vnd.tradestation.streams.v2+json',
        },
        responseType: 'stream',
        signal: abortController.signal,
        timeout: 0 // No timeout for streaming
      });

      this.logger.info(`✅ HTTP streaming connected: ${subscriptionId}`);

      // Process streaming chunks
      this.processHttpStream(response, subscriptionId, 'bars');

    } catch (error) {
      this.logger.error(`❌ Failed to start HTTP streaming for ${params.symbol}:`, error);
      this.subscriptions.delete(subscriptionId);
      throw error;
    }

    return subscriptionId;
  }

  // Subscribe to quote streaming  
  async subscribeToQuotes(symbols: string[], subscriptionId?: string): Promise<string> {
    const id = subscriptionId || `quotes_${symbols.join('_')}_${Date.now()}`;
    
    if (!this.authToken) {
      throw new Error('Authentication token required for streaming');
    }

    this.logger.info(`📈 Starting HTTP streaming for quotes: ${symbols.join(', ')}`);

    // Build streaming URL for quotes - multiple symbols (URL encode each symbol)
    const encodedSymbols = symbols.map(symbol => encodeURIComponent(symbol));
    const symbolString = encodedSymbols.join(',');
    const streamUrl = `${this.config.baseUrl}/marketdata/stream/quotes/${symbolString}`;
    
    const abortController = new AbortController();
    
    const subscription: StreamingSubscription = {
      id,
      type: 'quotes',
      symbols: symbols,
      active: true,
      abortController,
      parameters: { symbols }
    };

    this.subscriptions.set(id, subscription);

    try {
      // Start HTTP streaming request
      const response = await axios.get(streamUrl, {
        headers: {
          'Authorization': `Bearer ${this.authToken.access_token}`,
          'Accept': 'application/vnd.tradestation.streams.v2+json',
        },
        responseType: 'stream',
        signal: abortController.signal,
        timeout: 0 // No timeout for streaming
      });

      this.logger.info(`✅ Quote HTTP streaming connected: ${id}`);

      // Process streaming chunks  
      this.processHttpStream(response, id, 'quotes');

    } catch (error) {
      this.logger.error(`❌ Failed to start quote streaming for ${symbols.join(', ')}:`, error);
      this.subscriptions.delete(id);
      throw error;
    }

    return id;
  }

  // Process HTTP streaming response using TradeStation engineer's pattern
  private processHttpStream(response: AxiosResponse, subscriptionId: string, type: 'bars' | 'quotes'): void {
    let buffer = '';
    
    response.data.on('data', (chunk: Buffer) => {
      try {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (!line.trim()) continue; // Skip empty lines
          
          try {
            const json = JSON.parse(line);
            
            // Handle heartbeat messages
            if ('Heartbeat' in json) {
              this.logger.debug(`💓 Stream heartbeat: ${subscriptionId}`);
              // Update subscription activity
              const subscription = this.subscriptions.get(subscriptionId);
              if (subscription) {
                subscription.lastActivity = Date.now();
              }
              continue;
            }
            
            // Handle error messages
            if (json.Error) {
              this.logger.error(`📊 Stream error for ${subscriptionId}: ${json.Error}`);
              this.emit('error', { subscriptionId, error: json.Error });
              continue;
            }
            
            // Handle data messages
            if (type === 'bars' && 'TimeStamp' in json) {
              // Update subscription activity
              const subscription = this.subscriptions.get(subscriptionId);
              if (subscription) {
                subscription.lastActivity = Date.now();
              }
              this.emit('bar', {
                subscriptionId,
                symbol: json.Symbol || this.subscriptions.get(subscriptionId)?.symbols[0],
                bar: json
              });
            } else if (type === 'quotes' && 'Symbol' in json) {
              // Update subscription activity
              const subscription = this.subscriptions.get(subscriptionId);
              if (subscription) {
                subscription.lastActivity = Date.now();
              }
              this.emit('quote', {
                subscriptionId,
                symbol: json.Symbol,
                quote: json
              });
            }
            
          } catch (parseError) {
            this.logger.debug(`Skipping invalid JSON: ${line.substring(0, 50)}...`);
          }
        }
      } catch (error) {
        this.logger.error(`Error processing stream data for ${subscriptionId}:`, error);
      }
    });

    response.data.on('end', () => {
      this.logger.warn(`📊 HTTP stream ended unexpectedly: ${subscriptionId}`);
      this.handleStreamEnd(subscriptionId);
      // Attempt to reconnect after 5 seconds
      setTimeout(() => {
        this.logger.info(`Attempting to reconnect stream: ${subscriptionId}`);
        this.reconnectStream(subscriptionId);
      }, 5000);
    });

    response.data.on('error', (error: Error) => {
      this.logger.error(`📊 HTTP stream error: ${subscriptionId}`, error);
      this.emit('error', { subscriptionId, error });
      this.handleStreamEnd(subscriptionId);
      // Attempt to reconnect after 5 seconds
      setTimeout(() => {
        this.logger.info(`Attempting to reconnect stream after error: ${subscriptionId}`);
        this.reconnectStream(subscriptionId);
      }, 5000);
    });
  }



  // Unsubscribe from a stream
  unsubscribe(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription) {
      subscription.active = false;
      if (subscription.abortController) {
        subscription.abortController.abort();
      }
      this.subscriptions.delete(subscriptionId);
      this.logger.info(`📊 Unsubscribed from stream: ${subscriptionId}`);
    }
  }

  // Unsubscribe from all streams
  unsubscribeAll(): void {
    for (const [subscriptionId] of this.subscriptions) {
      this.unsubscribe(subscriptionId);
    }
  }

  // Reconnect a stream
  private async reconnectStream(subscriptionId: string): Promise<void> {
    // Check if subscription still exists and should reconnect
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription || !subscription.active) {
      this.logger.info(`Stream ${subscriptionId} no longer active, skipping reconnect`);
      return;
    }

    try {
      // Resubscribe based on type
      if (subscription.type === 'bars') {
        const [symbol] = subscription.symbols;
        const params = subscription.parameters;
        await this.subscribeToBars({
          symbol,
          interval: params?.interval || 1,
          unit: params?.unit || 'Minute'
        });
      } else if (subscription.type === 'quotes') {
        await this.subscribeToQuotes(subscription.symbols);
      }
      this.logger.info(`Successfully reconnected stream: ${subscriptionId}`);
    } catch (error) {
      this.logger.error(`Failed to reconnect stream ${subscriptionId}:`, error);
      // Try again in 30 seconds
      setTimeout(() => this.reconnectStream(subscriptionId), 30000);
    }
  }

  // Handle stream end
  private handleStreamEnd(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription) {
      subscription.active = false;
      this.subscriptions.delete(subscriptionId);
    }
  }

  // Cleanup
  destroy(): void {
    this.unsubscribeAll();
    this.removeAllListeners();
  }

  // Check if subscription is active
  isActive(subscriptionId: string): boolean {
    return this.subscriptions.get(subscriptionId)?.active === true;
  }
}