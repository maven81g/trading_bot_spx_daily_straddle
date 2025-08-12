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

    // Build streaming URL - HTTP streaming endpoint
    const streamUrl = `${this.config.baseUrl}/marketdata/stream/barcharts/${params.symbol}?interval=${params.interval}&unit=${params.unit.toLowerCase()}`;
    
    const abortController = new AbortController();
    
    const subscription: StreamingSubscription = {
      id: subscriptionId,
      type: 'bars',
      symbols: [params.symbol],
      active: true,
      abortController
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

    // Build streaming URL for quotes - multiple symbols
    const symbolString = symbols.join(',');
    const streamUrl = `${this.config.baseUrl}/marketdata/stream/quote/changes/${symbolString}`;
    
    const abortController = new AbortController();
    
    const subscription: StreamingSubscription = {
      id,
      type: 'quotes',
      symbols: symbols,
      active: true,
      abortController
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

  // Process HTTP streaming response
  private processHttpStream(response: AxiosResponse, subscriptionId: string, type: 'bars' | 'quotes'): void {
    let buffer = '';
    
    response.data.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      
      // Process complete JSON objects
      this.processBuffer(buffer, subscriptionId, type);
      
      // Keep only incomplete data in buffer
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline > -1) {
        buffer = buffer.substring(lastNewline + 1);
      }
    });

    response.data.on('end', () => {
      this.logger.info(`📊 HTTP stream ended: ${subscriptionId}`);
      this.handleStreamEnd(subscriptionId);
    });

    response.data.on('error', (error: Error) => {
      this.logger.error(`📊 HTTP stream error: ${subscriptionId}`, error);
      this.emit('error', { subscriptionId, error });
      this.handleStreamEnd(subscriptionId);
    });
  }

  // Process buffer for JSON objects  
  private processBuffer(buffer: string, subscriptionId: string, type: 'bars' | 'quotes'): void {
    const lines = buffer.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      try {
        const data = JSON.parse(trimmed);
        
        if (data.Error) {
          this.logger.error(`📊 Stream error for ${subscriptionId}: ${data.Error}`);
          this.emit('error', { subscriptionId, error: data.Error });
          continue;
        }

        // Emit appropriate event based on type
        if (type === 'bars' && this.isBarData(data)) {
          this.emit('bar', {
            subscriptionId,
            symbol: (data as any).Symbol || this.subscriptions.get(subscriptionId)?.symbols[0],
            bar: data
          });
        } else if (type === 'quotes' && this.isQuoteData(data)) {
          this.emit('quote', {
            subscriptionId,
            symbol: data.Symbol,
            quote: data
          });
        }

      } catch (error) {
        // Not valid JSON, might be partial - ignore
        this.logger.debug(`📊 Skipping invalid JSON in stream: ${trimmed.substring(0, 50)}...`);
      }
    }
  }

  // Type guards
  private isBarData(data: any): data is Bar {
    return data && typeof data.Close === 'string' && typeof data.Open === 'string';
  }

  private isQuoteData(data: any): data is Quote {
    return data && typeof data.Last === 'string' && typeof data.Symbol === 'string';
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