// TradeStation API Client - Simplified with Refresh Token Authentication

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { EventEmitter } from 'events';
import { Logger } from 'winston';
import * as fs from 'fs';
import * as path from 'path';
import { 
  TradeStationConfig, 
  AuthToken, 
  ApiResponse,
  Account,
  Balance,
  Position,
  Order,
  OrderRequest,
  OrderResponse,
  BarChartParams,
  BarsResponse,
  Quote,
  SymbolDetail
} from '../types/tradestation';
import { createLogger } from '../utils/logger';

export class TradeStationClient extends EventEmitter {
  private config: TradeStationConfig;
  private httpClient: AxiosInstance;
  private authToken: AuthToken | null = null;
  private logger: Logger;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;

  // API URLs
  private readonly apiUrl = 'https://sim-api.tradestation.com/v3';
  private readonly authUrl = 'https://signin.tradestation.com';

  constructor(config: TradeStationConfig) {
    super();
    this.config = config;
    this.logger = createLogger('TradeStationClient');
    
    // Create HTTP client
    this.httpClient = axios.create({
      baseURL: this.apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SPX-Trading-Bot/1.0'
      }
    });

    // Setup request interceptor for authentication
    this.httpClient.interceptors.request.use(
      (config) => {
        if (this.authToken?.access_token) {
          config.headers['Authorization'] = `Bearer ${this.authToken.access_token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Setup response interceptor for error handling
    this.httpClient.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401 && this.authToken?.refresh_token) {
          // Try to refresh token and retry
          const refreshed = await this.refreshAccessToken();
          if (refreshed && error.config) {
            return this.httpClient.request(error.config);
          }
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Authenticate using refresh token (simplified approach from backtest)
   */
  async authenticateWithRefreshToken(refreshToken: string): Promise<boolean> {
    try {
      this.logger.info('🔄 Authenticating with refresh token...');
      
      const response = await axios.post(`${this.authUrl}/oauth/token`, {
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken
      });

      if (response.data?.access_token) {
        this.authToken = {
          access_token: response.data.access_token,
          refresh_token: response.data.refresh_token || refreshToken,
          token_type: response.data.token_type || 'Bearer',
          expires_in: response.data.expires_in || 1200,
          scope: response.data.scope || 'ReadAccount',
          timestamp: Date.now()
        };

        this.logger.info('✅ Authentication successful');
        this.emit('authenticated', this.authToken);
        
        // Save credentials
        this.saveCredentials();
        
        // Setup auto-refresh
        this.setupTokenAutoRefresh();
        
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error('❌ Authentication failed:', error.response?.data || error.message);
      this.emit('authError', error);
      return false;
    }
  }

  /**
   * Load credentials from file if available
   */
  loadSavedCredentials(): boolean {
    // Skip loading credentials in Cloud Run (use fresh tokens from secrets)
    if (process.env.RUNNING_IN_CLOUD === 'true') {
      return false;
    }
    
    try {
      const credentialsPath = path.join(process.cwd(), '.ts_credentials.json');
      if (fs.existsSync(credentialsPath)) {
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        
        // Check if token is still valid (with 5-minute buffer)
        const tokenAge = Date.now() - (credentials.timestamp || 0);
        const expiryTime = (credentials.expires_in || 1200) * 1000;
        
        if (tokenAge < (expiryTime - 300000)) {
          this.authToken = credentials;
          this.logger.info('✅ Loaded valid credentials from file');
          this.setupTokenAutoRefresh();
          return true;
        } else {
          this.logger.info('⏰ Saved credentials are expired');
        }
      }
    } catch (error) {
      this.logger.error('Error loading saved credentials:', error);
    }
    return false;
  }

  /**
   * Save credentials to file (skip in Cloud Run)
   */
  private saveCredentials(): void {
    // Skip saving credentials in Cloud Run (no file system write access)
    if (process.env.RUNNING_IN_CLOUD === 'true') {
      this.logger.debug('Skipping credential save in Cloud Run mode');
      return;
    }
    
    try {
      if (this.authToken) {
        const credentialsPath = path.join(process.cwd(), '.ts_credentials.json');
        fs.writeFileSync(credentialsPath, JSON.stringify(this.authToken, null, 2));
      }
    } catch (error) {
      this.logger.error('Error saving credentials:', error);
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(): Promise<boolean> {
    if (!this.authToken?.refresh_token) {
      return false;
    }

    return this.authenticateWithRefreshToken(this.authToken.refresh_token);
  }

  /**
   * Setup automatic token refresh
   */
  private setupTokenAutoRefresh(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    if (this.authToken?.expires_in) {
      // Refresh 5 minutes before expiry
      const refreshTime = (this.authToken.expires_in - 300) * 1000;
      this.tokenRefreshTimer = setTimeout(() => {
        this.refreshAccessToken();
      }, refreshTime);
    }
  }

  // Authentication Status
  isAuthenticated(): boolean {
    return !!this.authToken?.access_token;
  }

  getToken(): AuthToken | null {
    return this.authToken;
  }

  // API Methods

  async getAccounts(): Promise<ApiResponse<Account[]>> {
    try {
      const response = await this.httpClient.get('/brokerage/accounts');
      return { success: true, data: response.data.Accounts || [] };
    } catch (error) {
      this.logger.error('Error fetching accounts:', error);
      return { success: false, error: error.message };
    }
  }

  async getBalances(accountIds: string[]): Promise<ApiResponse<Balance[]>> {
    try {
      const promises = accountIds.map(id => 
        this.httpClient.get(`/brokerage/accounts/${id}/balances`)
      );
      
      const responses = await Promise.all(promises);
      const balances = responses.map(r => r.data).filter(Boolean);
      
      return { success: true, data: balances };
    } catch (error) {
      this.logger.error('Error fetching balances:', error);
      return { success: false, error: error.message };
    }
  }

  async getPositions(accountIds: string[]): Promise<ApiResponse<Position[]>> {
    try {
      const promises = accountIds.map(id => 
        this.httpClient.get(`/brokerage/accounts/${id}/positions`)
      );
      
      const responses = await Promise.all(promises);
      const positions = responses.flatMap(r => r.data.Positions || []);
      
      return { success: true, data: positions };
    } catch (error) {
      this.logger.error('Error fetching positions:', error);
      return { success: false, error: error.message };
    }
  }

  async getBars(params: BarChartParams): Promise<ApiResponse<BarsResponse>> {
    try {
      // Extract symbol from params and put it in URL path, rest as query params
      const { symbol, ...queryParams } = params;
      const response = await this.httpClient.get(`/marketdata/barcharts/${symbol}`, { 
        params: queryParams 
      });
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error fetching bars:', error);
      return { success: false, error: error.message };
    }
  }

  async getQuote(symbol: string): Promise<ApiResponse<Quote>> {
    try {
      const response = await this.httpClient.get(`/marketdata/quotes/${symbol}`);
      // TradeStation returns Quotes array, extract first quote
      const quotes = response.data.Quotes || response.data;
      const quote = Array.isArray(quotes) ? quotes[0] : quotes;
      
      if (!quote) {
        this.logger.error(`No quote data returned for symbol: ${symbol}`);
        return { success: false, error: 'No quote data available' };
      }
      
      return { success: true, data: quote };
    } catch (error) {
      this.logger.error('Error fetching quote:', error);
      return { success: false, error: error.message };
    }
  }

  async placeOrder(order: OrderRequest): Promise<ApiResponse<OrderResponse>> {
    try {
      // TradeStation API endpoint for orders  
      const endpoint = `/orderexecution/orders`;
      this.logger.info(`Placing order to endpoint: ${endpoint}`, { order });
      
      const response = await this.httpClient.post(endpoint, order);
      this.logger.info(`Order placed successfully:`, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      // Extract detailed error information
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as any;
        const statusCode = axiosError.response?.status;
        const statusText = axiosError.response?.statusText;
        const apiError = axiosError.response?.data;
        
        this.logger.error(`Order placement failed - Status: ${statusCode} ${statusText}`, {
          endpoint: `/orderexecution/orders`,
          order: order,
          errorResponse: apiError,
          errorMessage: axiosError.message,
          fullError: {
            status: statusCode,
            statusText: statusText,
            data: apiError,
            headers: axiosError.response?.headers
          }
        });
        
        return { success: false, error: `${statusCode}: ${JSON.stringify(apiError)}`, data: apiError };
      }
      
      this.logger.error('Error placing order (non-API error):', error);
      return { success: false, error: error.message };
    }
  }

  async cancelOrder(orderId: string): Promise<ApiResponse<any>> {
    try {
      // Get account from first available account (simplified)
      const accountsResponse = await this.getAccounts();
      if (!accountsResponse.success || !accountsResponse.data?.length) {
        return { success: false, error: 'No accounts available' };
      }
      
      const accountId = accountsResponse.data[0].AccountID;
      const response = await this.httpClient.delete(`/brokerage/accounts/${accountId}/orders/${orderId}`);
      return { success: true, data: response.data };
    } catch (error) {
      this.logger.error('Error cancelling order:', error);
      return { success: false, error: error.message };
    }
  }

  async getOrders(accountId: string): Promise<ApiResponse<Order[]>> {
    try {
      const response = await this.httpClient.get(`/brokerage/accounts/${accountId}/orders`);
      return { success: true, data: response.data.Orders || [] };
    } catch (error) {
      this.logger.error('Error fetching orders:', error);
      return { success: false, error: error.message };
    }
  }

  // Cleanup
  destroy(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    this.removeAllListeners();
  }
}