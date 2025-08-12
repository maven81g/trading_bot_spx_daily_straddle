// TradeStation API Client

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { EventEmitter } from 'events';
import { Logger } from 'winston';
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
} from '@/types/tradestation';
import { createLogger } from '@/utils/logger';

export class TradeStationClient extends EventEmitter {
  private config: TradeStationConfig;
  private httpClient: AxiosInstance;
  private authToken: AuthToken | null = null;
  private logger: Logger;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;

  constructor(config: TradeStationConfig) {
    super();
    this.config = config;
    this.logger = createLogger('TradeStationClient');
    
    this.httpClient = axios.create({
      baseURL: config.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor to add auth token
    this.httpClient.interceptors.request.use(
      (config) => {
        if (this.authToken && config.headers) {
          config.headers.Authorization = `Bearer ${this.authToken.access_token}`;
        }
        return config;
      },
      (error) => {
        this.logger.error('Request interceptor error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for error handling
    this.httpClient.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;
          
          try {
            await this.refreshToken();
            return this.httpClient(originalRequest);
          } catch (refreshError) {
            this.logger.error('Token refresh failed:', refreshError);
            this.emit('authError', refreshError);
            return Promise.reject(refreshError);
          }
        }

        this.logger.error('API Error:', {
          url: error.config?.url,
          status: error.response?.status,
          message: error.response?.data?.message || error.message,
        });

        return Promise.reject(error);
      }
    );
  }

  // Authentication Methods
  async authenticate(authCode: string): Promise<ApiResponse<AuthToken>> {
    try {
      const response = await axios.post(`${this.config.baseURL}/oauth/token`, {
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code: authCode,
        redirect_uri: this.config.redirectUri,
      });

      this.authToken = response.data;
      this.scheduleTokenRefresh();
      this.emit('authenticated', this.authToken);

      this.logger.info('Successfully authenticated with TradeStation API');
      return { success: true, data: this.authToken };
    } catch (error: any) {
      this.logger.error('Authentication failed:', error.response?.data || error.message);
      return { 
        success: false, 
        error: error.response?.data?.error_description || error.message 
      };
    }
  }

  async refreshToken(): Promise<ApiResponse<AuthToken>> {
    if (!this.authToken?.refresh_token) {
      return { success: false, error: 'No refresh token available' };
    }

    try {
      const response = await axios.post(`${this.config.baseURL}/oauth/token`, {
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.authToken.refresh_token,
      });

      this.authToken = response.data;
      this.scheduleTokenRefresh();
      this.emit('tokenRefreshed', this.authToken);

      this.logger.info('Token refreshed successfully');
      return { success: true, data: this.authToken };
    } catch (error: any) {
      this.logger.error('Token refresh failed:', error.response?.data || error.message);
      return { 
        success: false, 
        error: error.response?.data?.error_description || error.message 
      };
    }
  }

  private scheduleTokenRefresh(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    if (this.authToken) {
      // Refresh token 5 minutes before expiration
      const refreshTime = (this.authToken.expires_in - 300) * 1000;
      this.tokenRefreshTimer = setTimeout(() => {
        this.refreshToken();
      }, refreshTime);
    }
  }

  getAuthUrl(): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'MarketData ReadAccount Trade Matrix OptionSpreads',
    });

    return `${this.config.baseURL}/oauth/authorize?${params}`;
  }

  // Account Methods
  async getAccounts(): Promise<ApiResponse<Account[]>> {
    try {
      const response = await this.httpClient.get('/v3/brokerage/accounts');
      return { success: true, data: response.data.Accounts || [] };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  async getBalances(accountIds: string[]): Promise<ApiResponse<Balance[]>> {
    try {
      const accountString = accountIds.join(',');
      const response = await this.httpClient.get(`/v3/brokerage/accounts/${accountString}/balances`);
      return { success: true, data: response.data.Balances || [] };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  async getPositions(accountIds: string[], symbol?: string): Promise<ApiResponse<Position[]>> {
    try {
      const accountString = accountIds.join(',');
      const url = `/v3/brokerage/accounts/${accountString}/positions`;
      const params = symbol ? { symbol } : {};
      
      const response = await this.httpClient.get(url, { params });
      return { success: true, data: response.data.Positions || [] };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  async getOrders(accountIds: string[]): Promise<ApiResponse<Order[]>> {
    try {
      const accountString = accountIds.join(',');
      const response = await this.httpClient.get(`/v3/brokerage/accounts/${accountString}/orders`);
      return { success: true, data: response.data.Orders || [] };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  // Market Data Methods
  async getBars(params: BarChartParams): Promise<ApiResponse<BarsResponse>> {
    try {
      const queryParams = new URLSearchParams();
      queryParams.append('symbol', params.symbol);
      
      if (params.interval) queryParams.append('interval', params.interval.toString());
      if (params.unit) queryParams.append('unit', params.unit);
      if (params.barsback) queryParams.append('barsback', params.barsback.toString());
      if (params.firstdate) queryParams.append('firstdate', params.firstdate);
      if (params.lastdate) queryParams.append('lastdate', params.lastdate);
      if (params.sessiontemplate) queryParams.append('sessiontemplate', params.sessiontemplate);

      const response = await this.httpClient.get(`/v3/marketdata/barcharts/${params.symbol}?${queryParams}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  async getQuotes(symbols: string[]): Promise<ApiResponse<Quote[]>> {
    try {
      const symbolString = symbols.join(',');
      const response = await this.httpClient.get(`/v3/marketdata/quotes/${symbolString}`);
      return { success: true, data: response.data.Quotes || [] };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  async getSymbolDetails(symbols: string[]): Promise<ApiResponse<SymbolDetail[]>> {
    try {
      const symbolString = symbols.join(',');
      const response = await this.httpClient.get(`/v3/marketdata/symbols/${symbolString}`);
      return { success: true, data: response.data.Symbols || [] };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  // Order Execution Methods
  async placeOrder(order: OrderRequest): Promise<ApiResponse<OrderResponse>> {
    try {
      const response = await this.httpClient.post('/v3/orderexecution/orders', order);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  async cancelOrder(orderId: string): Promise<ApiResponse<OrderResponse>> {
    try {
      const response = await this.httpClient.delete(`/v3/orderexecution/orders/${orderId}`);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  async replaceOrder(orderId: string, modifications: Partial<OrderRequest>): Promise<ApiResponse<OrderResponse>> {
    try {
      const response = await this.httpClient.put(`/v3/orderexecution/orders/${orderId}`, modifications);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  async confirmOrder(order: OrderRequest): Promise<ApiResponse<any>> {
    try {
      const response = await this.httpClient.post('/v3/orderexecution/orderconfirm', order);
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.Message || error.message };
    }
  }

  // Utility Methods
  isAuthenticated(): boolean {
    return this.authToken !== null && new Date() < new Date(Date.now() + this.authToken.expires_in * 1000);
  }

  getToken(): AuthToken | null {
    return this.authToken;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.httpClient.get('/v3/brokerage/accounts');
      return true;
    } catch (error) {
      this.logger.error('Health check failed:', error);
      return false;
    }
  }

  // Cleanup
  destroy(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    this.removeAllListeners();
    this.authToken = null;
  }
}