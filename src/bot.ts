// Main Trading Bot Class

import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { TradeStationClient } from './api/client';
import { StrategyManager } from './strategies/strategy-manager';
import { RiskManager } from './risk/risk-manager';
import { PortfolioManager } from './risk/portfolio-manager';
import { 
  TradeStationConfig, 
  Account, 
  Balance, 
  Position,
  Bar,
  Quote,
  OrderRequest,
  OrderResponse
} from './types/tradestation';
import { 
  StrategyConfig, 
  Signal, 
  MarketContext,
  StrategyState
} from './types/strategy';
import { createLogger } from './utils/logger';
// Removed loadConfig import - using direct configuration

export interface BotConfig {
  tradeStation: TradeStationConfig;
  strategies: StrategyConfig[];
  riskManagement: {
    maxDailyLoss: number;
    maxDrawdown: number;
    maxPositionsPerSymbol: number;
    maxTotalPositions: number;
  };
  execution: {
    paperTrading: boolean;
    orderTimeout: number;
    maxSlippage: number;
  };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    file?: string;
  };
}

export interface BotState {
  status: 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';
  accounts: Account[];
  balances: Map<string, Balance>;
  positions: Map<string, Position[]>;
  activeStrategies: Map<string, StrategyState>;
  totalPnL: number;
  dailyPnL: number;
  startTime: Date;
  lastUpdate: Date;
}

export class TradingBot extends EventEmitter {
  private config: BotConfig;
  private logger: Logger;
  private state: BotState;
  
  // Core Components
  private apiClient: TradeStationClient;
  private strategyManager: StrategyManager;
  private riskManager: RiskManager;
  private portfolioManager: PortfolioManager;
  
  // Data Management
  private marketData: Map<string, Bar[]> = new Map();
  private pendingOrders: Map<string, OrderRequest> = new Map();
  private indicators: Map<string, Map<string, number | number[]>> = new Map(); // Store indicators per symbol
  
  // Timers and Intervals
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private dataUpdateInterval: NodeJS.Timeout | null = null;
  private performanceUpdateInterval: NodeJS.Timeout | null = null;
  private spxDataPollingInterval: NodeJS.Timeout | null = null;
  private fastPriceUpdateInterval: NodeJS.Timeout | null = null; // 10-second price updates
  private optionMonitoringInterval: NodeJS.Timeout | null = null; // 10-second option monitoring

  constructor(config: BotConfig) {
    super();
    this.config = config;
    this.logger = createLogger('TradingBot', config.logging);
    
    // Initialize state
    this.state = {
      status: 'STOPPED',
      accounts: [],
      balances: new Map(),
      positions: new Map(),
      activeStrategies: new Map(),
      totalPnL: 0,
      dailyPnL: 0,
      startTime: new Date(),
      lastUpdate: new Date()
    };

    // Initialize components
    this.apiClient = new TradeStationClient(config.tradeStation);
    this.strategyManager = new StrategyManager();
    this.riskManager = new RiskManager(config.riskManagement);
    this.portfolioManager = new PortfolioManager();

    this.setupEventListeners();
  }

  // Bot Lifecycle
  async start(): Promise<void> {
    try {
      this.logger.info('Starting Trading Bot...');
      this.state.status = 'STARTING';
      this.state.startTime = new Date();

      // 1. Authenticate with TradeStation
      await this.authenticate();

      // 2. Load account information
      await this.loadAccountData();

      // 3. Initialize strategies
      await this.initializeStrategies();

      // 4. Start SPX data polling for real-time dashboard
      this.startSPXDataPolling();

      // 5. Start monitoring intervals
      this.startMonitoring();

      this.state.status = 'RUNNING';
      this.logger.info('Trading Bot started successfully');
      this.emit('started', this.getState());

    } catch (error) {
      this.state.status = 'ERROR';
      this.logger.error('Failed to start Trading Bot:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      this.logger.info('Stopping Trading Bot...');
      this.state.status = 'STOPPING';

      // 1. Stop all monitoring and data polling
      this.stopMonitoring();
      this.stopSPXDataPolling();

      // 2. Close all positions if configured
      if (this.config.execution.paperTrading === false) {
        await this.closeAllPositions();
      }

      // 3. Cancel pending orders
      await this.cancelAllPendingOrders();

      // 4. Shutdown strategies
      await this.shutdownStrategies();

      // 5. No streaming to close

      // 6. Cleanup
      this.apiClient.destroy();

      this.state.status = 'STOPPED';
      this.logger.info('Trading Bot stopped successfully');
      this.emit('stopped', this.getState());

    } catch (error) {
      this.state.status = 'ERROR';
      this.logger.error('Error stopping Trading Bot:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    await this.start();
  }

  // Authentication - Simplified with refresh token
  private async authenticate(): Promise<void> {
    // First try to load saved credentials
    if (this.apiClient.loadSavedCredentials()) {
      this.logger.info('✅ Using saved credentials');
    } else {
      // Use refresh token from environment or config
      const refreshToken = process.env.TRADESTATION_REFRESH_TOKEN;
      if (!refreshToken) {
        throw new Error('TRADESTATION_REFRESH_TOKEN is required. Please set it in your environment variables.');
      }

      const success = await this.apiClient.authenticateWithRefreshToken(refreshToken);
      if (!success) {
        throw new Error('Authentication failed with refresh token');
      }
    }

    // Authentication complete
  }

  // Account Data Management
  private async loadAccountData(): Promise<void> {
    this.logger.info('Loading account data...');

    // Load accounts
    const accountsResponse = await this.apiClient.getAccounts();
    if (!accountsResponse.success || !accountsResponse.data) {
      throw new Error('Failed to load accounts');
    }
    this.state.accounts = accountsResponse.data;

    // Load balances
    const accountIds = this.state.accounts.map(acc => acc.AccountID);
    const balancesResponse = await this.apiClient.getBalances(accountIds);
    if (balancesResponse.success && balancesResponse.data) {
      this.state.balances.clear();
      for (const balance of balancesResponse.data) {
        this.state.balances.set(balance.AccountID, balance);
      }
    }

    // Load positions
    const positionsResponse = await this.apiClient.getPositions(accountIds);
    if (positionsResponse.success && positionsResponse.data) {
      this.state.positions.clear();
      // Group positions by account
      for (const position of positionsResponse.data) {
        const accountPositions = this.state.positions.get(position.AccountID) || [];
        accountPositions.push(position);
        this.state.positions.set(position.AccountID, accountPositions);
      }
    }

    // Initialize portfolio manager with current data
    this.portfolioManager.updatePositions(Array.from(this.state.positions.values()).flat());
    this.portfolioManager.updateBalances(Array.from(this.state.balances.values()));

    this.logger.info(`Loaded ${this.state.accounts.length} accounts with ${Array.from(this.state.positions.values()).flat().length} positions`);
  }

  // Strategy Management
  private async initializeStrategies(): Promise<void> {
    this.logger.info('Initializing strategies...');

    for (const strategyConfig of this.config.strategies) {
      try {
        await this.strategyManager.addStrategy(strategyConfig);
        this.state.activeStrategies.set(strategyConfig.id, 'ACTIVE');
        this.logger.info(`Initialized strategy: ${strategyConfig.name}`);
      } catch (error) {
        this.logger.error(`Failed to initialize strategy ${strategyConfig.name}:`, error);
        this.state.activeStrategies.set(strategyConfig.id, 'ERROR');
      }
    }
  }

  private async shutdownStrategies(): Promise<void> {
    this.logger.info('Shutting down strategies...');
    await this.strategyManager.shutdown();
    this.state.activeStrategies.clear();
  }

  // SPX Data Polling for Real-time Dashboard
  private startSPXDataPolling(): void {
    this.logger.info('📊 Starting SPX data polling for real-time dashboard...');
    
    // First load historical data to initialize MACD indicators
    this.loadHistoricalSPXData().then(() => {
      // Then start 1-minute bar polling to match TradingView 1-minute interval
      this.spxDataPollingInterval = setInterval(async () => {
        try {
          await this.fetchLatest1MinuteBar();
        } catch (error) {
          this.logger.error('Error fetching SPX 1-minute bar:', error);
        }
      }, 60000); // Poll every 60 seconds for 1-minute bars
      
      // Fetch initial 1-minute bar immediately after historical load
      setTimeout(() => this.fetchLatest1MinuteBar(), 1000);
      
      // Start 10-second price updates for real-time display
      this.startFastPriceUpdates();
      
      // Start 10-second option monitoring if we have positions
      this.startOptionMonitoring();
    }).catch(error => {
      this.logger.error('Failed to load historical SPX data:', error);
      // Still start polling even if historical load fails
      this.spxDataPollingInterval = setInterval(async () => {
        try {
          await this.fetchLatest1MinuteBar();
        } catch (error) {
          this.logger.error('Error fetching SPX 1-minute bar:', error);
        }
      }, 60000);
      
      // Also start fast updates in fallback case
      this.startFastPriceUpdates();
      this.startOptionMonitoring();
    });
  }

  private async loadHistoricalSPXData(): Promise<void> {
    try {
      this.logger.info('📚 Loading historical SPX data for MACD calculation...');
      
      // Try both $SPX.X and $SPXW.X for historical data
      let response;
      try {
        // Try $SPXW.X for historical data first (matches our real-time symbol)
        this.logger.info('📚 Trying $SPXW.X for historical bars...');
        response = await this.apiClient.getBars({
          symbol: '$SPXW.X',
          interval: 1,
          unit: 'Minute',
          barsback: 500 // Much more historical data to match TradingView depth
        });
      } catch (error) {
        this.logger.warn('$SPXW.X failed, trying $SPX.X for historical bars...');
        // Fallback to $SPX.X
        response = await this.apiClient.getBars({
          symbol: '$SPX.X',
          interval: 1,
          unit: 'Minute',
          barsback: 500 // Much more historical data to match TradingView depth
        });
      }
      
      if (response.success && response.data?.Bars) {
        const bars = response.data.Bars;
        this.logger.info(`📚 Loaded ${bars.length} historical SPX bars`);
        
        // Process each historical bar to build MACD indicators using $SPXW.X symbol
        for (const bar of bars) {
          // Store bar data under $SPXW.X regardless of source symbol
          let spxBars = this.marketData.get('$SPXW.X') || [];
          spxBars.push(bar);
          
          // Keep only last 500 bars for memory management
          if (spxBars.length > 500) {
            spxBars = spxBars.slice(-500);
          }
          this.marketData.set('$SPXW.X', spxBars);
          
          // Process with strategies to build MACD indicators (use $SPXW.X symbol)
          const context = await this.createMarketContext('$SPXW.X', bar);
          await this.strategyManager.onBar('$SPXW.X', bar, context);
        }
        
        this.logger.info('📚 Historical SPX data loaded and MACD indicators initialized');
      } else {
        this.logger.warn('Failed to load historical SPX data:', response.error);
      }
    } catch (error) {
      this.logger.error('Error loading historical SPX data:', error instanceof Error ? error.message : String(error));
    }
  }

  private async fetchSPXData(): Promise<void> {
    try {
      this.logger.info('🔄 Fetching SPX quote for $SPXW.X...');
      
      // Get SPX quote using TradeStation REST API
      const response = await this.apiClient.getQuote('$SPXW.X');
      
      this.logger.info('📡 API Response:', {
        success: response.success,
        error: response.error,
        hasData: !!response.data
      });
      
      if (response.success && response.data) {
        const quote = response.data;
        
        // Debug: log the COMPLETE response structure including any nested data
        this.logger.info('📊 FULL API Response Structure:', JSON.stringify(response, null, 2));
        
        // TradeStation might return data in different formats, let's check for various properties
        const priceData = (quote as any)?.Quotes?.[0] || (quote as any)?.Quote || quote;
        this.logger.info('📊 Price Data Found:', JSON.stringify(priceData, null, 2));
        
        // Try to extract price from various possible structures
        let lastPrice = priceData?.Last || priceData?.last || priceData?.LastPrice || 
                       priceData?.Close || priceData?.close || null;
        
        if (!lastPrice && Array.isArray(quote)) {
          // Maybe it's an array of quotes
          lastPrice = quote[0]?.Last || quote[0]?.last || quote[0]?.LastPrice;
        }
        
        this.logger.info('📊 Extracted Last Price:', lastPrice);
        
        // Use extracted price or fallback
        const currentPrice = lastPrice || '4850.00';
        
        // Convert quote to bar format for consistency with dashboard
        const simulatedBar = {
          Open: priceData?.Open || priceData?.open || currentPrice,
          High: priceData?.High || priceData?.high || currentPrice,
          Low: priceData?.Low || priceData?.low || currentPrice,
          Close: currentPrice,
          TimeStamp: new Date().toISOString(),
          TotalVolume: quote.Volume || '0',
          Epoch: Date.now(),
          IsRealtime: true,
          IsEndOfHistory: false,
          BarStatus: 'Close'
        };

        // Process the data like streaming would
        await this.handleBarUpdate({ symbol: '$SPXW.X', bar: simulatedBar });
        
      } else {
        this.logger.warn('Failed to fetch SPX quote:', response.error);
      }
    } catch (error) {
      this.logger.warn('SPX data polling error:', error instanceof Error ? error.message : String(error));
    }
  }

  private async fetchLatest1MinuteBar(): Promise<void> {
    try {
      this.logger.info('📊 Fetching latest 1-minute SPX bar for MACD...');
      
      // Get the latest 1-minute bar for $SPXW.X
      const response = await this.apiClient.getBars({
        symbol: '$SPXW.X',
        interval: 1,
        unit: 'Minute',
        barsback: 1 // Just get the latest bar
      });
      
      if (response.success && response.data?.Bars?.length > 0) {
        const latestBar = response.data.Bars[0];
        this.logger.info(`📊 Got 1-minute bar: ${latestBar.Close} at ${latestBar.TimeStamp}`);
        
        // Process this 1-minute bar exactly like historical bars
        await this.handleBarUpdate({ symbol: '$SPXW.X', bar: latestBar });
        
      } else {
        this.logger.warn('Failed to fetch latest 1-minute SPX bar:', response.error);
        // Fallback to quote method if 1-minute bars fail
        await this.fetchSPXData();
      }
    } catch (error) {
      this.logger.error('Error fetching latest 1-minute SPX bar:', error instanceof Error ? error.message : String(error));
      // Fallback to quote method if 1-minute bars fail
      await this.fetchSPXData();
    }
  }

  // Fast Price Updates (10 seconds) for real-time display
  private startFastPriceUpdates(): void {
    this.logger.info('⚡ Starting 10-second price updates for dashboard...');
    
    // Update SPX price every 10 seconds for real-time display
    this.fastPriceUpdateInterval = setInterval(async () => {
      try {
        await this.fetchSPXQuoteForDisplay();
      } catch (error) {
        this.logger.error('Error fetching fast SPX price update:', error);
      }
    }, 10000); // Every 10 seconds
    
    // Initial fast update
    setTimeout(() => this.fetchSPXQuoteForDisplay(), 2000);
  }

  // Option Position Monitoring (10 seconds) for stop loss and profit targets
  private startOptionMonitoring(): void {
    this.logger.info('📈 Starting 10-second option monitoring for positions...');
    
    // Monitor option positions every 10 seconds
    this.optionMonitoringInterval = setInterval(async () => {
      try {
        await this.monitorOptionPositions();
      } catch (error) {
        this.logger.error('Error monitoring option positions:', error);
      }
    }, 10000); // Every 10 seconds
  }

  private async fetchSPXQuoteForDisplay(): Promise<void> {
    try {
      // Get real-time SPX quote for price display (don't update MACD)
      const response = await this.apiClient.getQuote('$SPXW.X');
      
      if (response.success && response.data) {
        const quote = response.data;
        const priceData = (quote as any)?.Quotes?.[0] || (quote as any)?.Quote || quote;
        let lastPrice = priceData?.Last || priceData?.last || priceData?.LastPrice || 
                       priceData?.Close || priceData?.close || null;
        
        if (lastPrice) {
          // Update just the display price, keep MACD on 1-minute schedule
          this.updatePriceDisplay(parseFloat(lastPrice));
        }
      }
    } catch (error) {
      this.logger.debug('Fast price update error:', error instanceof Error ? error.message : String(error));
    }
  }

  private async monitorOptionPositions(): Promise<void> {
    try {
      // Get current SPX strategy to check for option positions
      const strategy = this.strategyManager.getStrategy('spx-backtest-strategy');
      if (!strategy || !(strategy as any).currentOptionPosition) {
        return; // No position to monitor
      }

      const position = (strategy as any).currentOptionPosition;
      this.logger.debug(`📊 Monitoring option position: ${position.symbol}`);
      
      // Get current option price
      const optionQuote = await this.apiClient.getQuote(position.symbol);
      if (!optionQuote.success || !optionQuote.data) {
        return;
      }

      // Extract current option price
      const quoteData = optionQuote.data;
      const priceData = (quoteData as any)?.Quotes?.[0] || (quoteData as any)?.Quote || quoteData;
      const currentPrice = parseFloat(priceData?.Last || priceData?.Close || '0');

      if (currentPrice > 0) {
        // Calculate profit/loss
        const unrealizedPL = (currentPrice - position.entryPrice) * position.quantity * 100;
        
        // Check profit target ($1.00 increase)
        const profitTarget = 1.0;
        const profitReached = unrealizedPL >= profitTarget;
        
        // Check stop loss (20% of entry price)
        const stopLossPercentage = 0.20;
        const stopLossPrice = position.entryPrice * (1 - stopLossPercentage);
        const stopLossHit = currentPrice <= stopLossPrice;
        
        // Get SPX momentum (current MACD indicators)
        const spxIndicators = this.indicators.get('$SPXW.X');
        const macdValue = spxIndicators?.get('macd') as number || 0;
        const macdSignal = spxIndicators?.get('macd_signal') as number || 0;
        const macdHistogram = spxIndicators?.get('macd_histogram') as number || 0;
        const macdCrossover = spxIndicators?.get('macd_crossover') as number || 0;
        
        const momentumShrinking = macdHistogram < (position.initialMacdHistogram || 0);
        const bearishCrossover = macdCrossover === -1; // Negative signal (bearish crossover)

        this.logger.info(`📊 Option Monitor: ${position.symbol} | Price: $${currentPrice.toFixed(2)} | P&L: $${unrealizedPL.toFixed(2)} | Histogram: ${macdHistogram.toFixed(4)} | Crossover: ${macdCrossover}`);

        // Generate exit signal if conditions met
        let exitReason = '';
        if (stopLossHit) {
          exitReason = 'Stop loss triggered (20% loss)';
        } else if (profitReached && momentumShrinking) {
          exitReason = 'Profit target ($1.00) + momentum shrinking';
        } else if (bearishCrossover) {
          exitReason = 'Negative signal (bearish MACD crossover)';
        }
        
        if (exitReason) {
          this.logger.warn(`🚨 Option exit condition: ${exitReason}`);
          
          // Create exit signal (this will be processed by strategy)
          await this.createOptionExitSignal(position, currentPrice, exitReason);
        }
      }
      
    } catch (error) {
      this.logger.debug('Option monitoring error:', error instanceof Error ? error.message : String(error));
    }
  }

  private updatePriceDisplay(price: number): void {
    // Update the last bar with current price for display purposes only
    const spxBars = this.marketData.get('$SPXW.X') || [];
    if (spxBars.length > 0) {
      const lastBar = spxBars[spxBars.length - 1];
      const updatedBar = {
        ...lastBar,
        Close: price.toString(),
        Last: price.toString(),
        TimeStamp: new Date().toISOString()
      };
      
      // Update display without affecting MACD calculation
      const context = this.indicators.get('$SPXW.X') || new Map();
      this.displayConsoleDashboard('$SPXW.X', updatedBar, {
        currentBar: updatedBar,
        previousBars: spxBars.slice(0, -1),
        currentQuote: { Last: price.toString() } as any,
        positions: [],
        portfolioValue: 0,
        availableCash: 0,
        timestamp: new Date(),
        symbol: '$SPXW.X',
        indicators: context
      });
    }
  }

  private async createOptionExitSignal(position: any, currentPrice: number, reason: string): Promise<void> {
    // This will be handled by the strategy, but we can trigger it here
    this.logger.warn(`🔔 Creating exit signal for ${position.symbol}: ${reason}`);
    // The strategy will handle the actual exit logic in its next update cycle
  }

  private stopSPXDataPolling(): void {
    if (this.spxDataPollingInterval) {
      clearInterval(this.spxDataPollingInterval);
      this.spxDataPollingInterval = null;
      this.logger.info('📊 Stopped SPX 1-minute data polling');
    }
    
    if (this.fastPriceUpdateInterval) {
      clearInterval(this.fastPriceUpdateInterval);
      this.fastPriceUpdateInterval = null;
      this.logger.info('⚡ Stopped 10-second price updates');
    }
    
    if (this.optionMonitoringInterval) {
      clearInterval(this.optionMonitoringInterval);
      this.optionMonitoringInterval = null;
      this.logger.info('📈 Stopped 10-second option monitoring');
    }
  }


  // Event Handling
  private setupEventListeners(): void {
    // API Client Events
    this.apiClient.on('authenticated', (token) => {
      this.logger.info('API authenticated successfully');
    });

    this.apiClient.on('authError', (error) => {
      this.logger.error('Authentication error:', error);
      this.emit('error', error);
    });

    // No streaming events - TradeStation simulation doesn't support WebSocket

    // Strategy Events
    this.strategyManager.on('signal', async (data) => {
      await this.handleStrategySignal(data);
    });

    this.strategyManager.on('error', (error) => {
      this.logger.error('Strategy error:', error);
    });

    // Risk Manager Events
    this.riskManager.on('riskViolation', (violation) => {
      this.logger.warn('Risk violation:', violation);
      this.emit('riskViolation', violation);
    });
  }

  // Data Processing
  private async handleBarUpdate(data: any): Promise<void> {
    try {
      const { symbol, bar } = data;
      
      // Store bar data
      let bars = this.marketData.get(symbol) || [];
      bars.push(bar);
      
      // Keep only last 500 bars for memory management
      if (bars.length > 500) {
        bars = bars.slice(-500);
      }
      this.marketData.set(symbol, bars);

      // Create market context with existing indicators
      const context = await this.createMarketContext(symbol, bar);
      
      // Process with strategies to calculate indicators
      await this.strategyManager.onBar(symbol, bar, context);
      
      // Store the calculated indicators for future use
      this.indicators.set(symbol, context.indicators);
      
      // Display console dashboard for SPX
      if (symbol === '$SPXW.X') {
        this.displayConsoleDashboard(symbol, bar, context);
      }
      
      this.state.lastUpdate = new Date();
    } catch (error) {
      this.logger.error('Error handling bar update:', error);
    }
  }

  private async handleQuoteUpdate(data: any): Promise<void> {
    try {
      const { symbol, quote } = data;
      
      // Create market context
      const bars = this.marketData.get(symbol) || [];
      const currentBar = bars[bars.length - 1];
      
      if (currentBar) {
        const context = await this.createMarketContext(symbol, currentBar);
        context.currentQuote = quote;
        
        // Process with strategies
        await this.strategyManager.onQuote(symbol, quote, context);
      }
      
      this.state.lastUpdate = new Date();
    } catch (error) {
      this.logger.error('Error handling quote update:', error);
    }
  }

  private async handleOrderUpdate(data: any): Promise<void> {
    try {
      this.logger.debug('Order update received:', data);
      
      // Update internal state and notify strategies
      await this.loadAccountData(); // Refresh positions and balances
      
      // Remove from pending orders if filled
      const order = data.data;
      if (order && order.OrderID && order.Status === 'FLL') {
        this.pendingOrders.delete(order.OrderID);
        
        // Notify strategies
        const symbol = order.Symbol;
        const bars = this.marketData.get(symbol) || [];
        const currentBar = bars[bars.length - 1];
        
        if (currentBar) {
          const context = await this.createMarketContext(symbol, currentBar);
          await this.strategyManager.onOrderFilled(symbol, order, context);
        }
      }
      
    } catch (error) {
      this.logger.error('Error handling order update:', error);
    }
  }

  private async handleStrategySignal(data: { strategyId: string; signals: Signal[] }): Promise<void> {
    try {
      for (const signal of data.signals) {
        await this.processSignal(signal);
      }
    } catch (error) {
      this.logger.error('Error handling strategy signal:', error);
    }
  }

  // Signal Processing and Order Execution
  private async processSignal(signal: Signal): Promise<void> {
    try {
      this.logger.info(`Processing signal: ${signal.type} ${signal.quantity} ${signal.symbol} @ ${signal.price}`);

      // Risk checks
      const context = await this.createMarketContext(signal.symbol);
      if (!this.riskManager.validateSignal(signal, context)) {
        this.logger.warn(`Signal rejected by risk manager: ${signal.id}`);
        return;
      }

      // Create order
      const order = await this.createOrderFromSignal(signal);
      if (!order) {
        this.logger.error(`Failed to create order from signal: ${signal.id}`);
        return;
      }

      // Execute order
      if (this.config.execution.paperTrading) {
        await this.executePaperOrder(order, signal);
      } else {
        await this.executeLiveOrder(order, signal);
      }

    } catch (error) {
      this.logger.error('Error processing signal:', error);
    }
  }

  private async createOrderFromSignal(signal: Signal): Promise<OrderRequest | null> {
    try {
      // Get primary account (first account for simplicity)
      const account = this.state.accounts[0];
      if (!account) {
        this.logger.error('No accounts available for order execution');
        return null;
      }

      const order: OrderRequest = {
        AccountID: account.AccountID,
        Symbol: signal.symbol,
        Quantity: signal.quantity.toString(),
        OrderType: 'Market', // Default to market orders
        TradeAction: this.mapSignalToTradeAction(signal.type),
        TimeInForce: {
          Duration: 'DAY'
        }
      };

      return order;
    } catch (error) {
      this.logger.error('Error creating order from signal:', error);
      return null;
    }
  }

  private mapSignalToTradeAction(signalType: string): any {
    switch (signalType) {
      case 'BUY':
        return 'BUY';
      case 'SELL':
        return 'SELL';
      case 'CLOSE_LONG':
        return 'SELL';
      case 'CLOSE_SHORT':
        return 'BUYTOCOVER';
      default:
        return 'BUY';
    }
  }

  private async executePaperOrder(order: OrderRequest, signal: Signal): Promise<void> {
    this.logger.info(`Paper trading: ${order.TradeAction} ${order.Quantity} ${order.Symbol}`);
    
    // Simulate order execution
    const mockOrder = {
      OrderID: `paper_${Date.now()}`,
      Symbol: order.Symbol,
      Quantity: order.Quantity,
      TradeAction: order.TradeAction,
      FilledPrice: signal.price.toString(),
      Status: 'FLL',
      OpenedDateTime: new Date().toISOString(),
      ClosedDateTime: new Date().toISOString(),
      CommissionFee: '0'
    };

    // Notify strategies of the "fill"
    const context = await this.createMarketContext(signal.symbol);
    await this.strategyManager.onOrderFilled(signal.symbol, mockOrder, context);
  }

  private async executeLiveOrder(order: OrderRequest, signal: Signal): Promise<void> {
    try {
      this.logger.info(`Executing live order: ${order.TradeAction} ${order.Quantity} ${order.Symbol}`);
      
      const response = await this.apiClient.placeOrder(order);
      
      if (response.success && response.data) {
        const orderId = response.data.OrderID;
        if (orderId) {
          this.pendingOrders.set(orderId, order);
          this.logger.info(`Order placed successfully: ${orderId}`);
        }
      } else {
        this.logger.error(`Order execution failed: ${response.error}`);
      }
    } catch (error) {
      this.logger.error('Error executing live order:', error);
    }
  }

  // Utility Methods
  private async createMarketContext(symbol: string, currentBar?: Bar): Promise<MarketContext> {
    const bars = this.marketData.get(symbol) || [];
    const bar = currentBar || bars[bars.length - 1];
    const previousBars = currentBar ? bars.slice(0, -1) : bars.slice(0, -1);
    
    // Get positions for this symbol
    const allPositions = Array.from(this.state.positions.values()).flat();
    const symbolPositions = allPositions.filter(p => p.Symbol === symbol);
    
    // Calculate portfolio value
    const portfolioValue = this.portfolioManager.getTotalValue();
    const availableCash = this.portfolioManager.getAvailableCash();

    return {
      currentBar: bar || {
        Open: '0', High: '0', Low: '0', Close: '0',
        TimeStamp: new Date().toISOString(),
        TotalVolume: '0', Epoch: Date.now(),
        IsRealtime: true, IsEndOfHistory: false,
        BarStatus: 'Open'
      },
      previousBars,
      currentQuote: {
        Symbol: symbol, Ask: '0', AskSize: '0', Bid: '0', BidSize: '0',
        Last: '0', High: '0', Low: '0', Open: '0', Close: '0',
        Volume: '0', NetChange: '0', NetChangePct: '0',
        PreviousClose: '0', TradeTime: new Date().toISOString(),
        MarketFlags: { IsDelayed: false, IsHalted: false, IsHardToBorrow: false, IsBats: false }
      },
      positions: symbolPositions,
      portfolioValue,
      availableCash,
      timestamp: new Date(),
      symbol,
      indicators: this.indicators.get(symbol) || new Map()
    };
  }

  private startMonitoring(): void {
    // Heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      this.emit('heartbeat', this.getState());
    }, 30000);

    // Update account data every 5 minutes
    this.dataUpdateInterval = setInterval(async () => {
      try {
        await this.loadAccountData();
      } catch (error) {
        this.logger.error('Error updating account data:', error);
      }
    }, 300000);

    // Update performance metrics every minute
    this.performanceUpdateInterval = setInterval(() => {
      this.updatePerformanceMetrics();
    }, 60000);
  }

  private stopMonitoring(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.dataUpdateInterval) {
      clearInterval(this.dataUpdateInterval);
      this.dataUpdateInterval = null;
    }
    
    if (this.performanceUpdateInterval) {
      clearInterval(this.performanceUpdateInterval);
      this.performanceUpdateInterval = null;
    }
  }

  private updatePerformanceMetrics(): void {
    // Update P&L calculations
    let totalPnL = 0;
    let dailyPnL = 0;

    // Calculate total P&L from positions
    const allPositions = Array.from(this.state.positions.values()).flat();
    for (const position of allPositions) {
      totalPnL += parseFloat(position.UnrealizedProfitLoss || '0');
    }

    // Update state
    this.state.totalPnL = totalPnL;
    this.state.dailyPnL = dailyPnL; // Would need more sophisticated calculation
    this.state.lastUpdate = new Date();

    // Update risk manager
    this.riskManager.updateDailyPnL(dailyPnL);
  }

  // Position management
  private async closeAllPositions(): Promise<void> {
    this.logger.info('Closing all positions...');
    
    const allPositions = Array.from(this.state.positions.values()).flat();
    for (const position of allPositions) {
      try {
        const closeOrder: OrderRequest = {
          AccountID: position.AccountID,
          Symbol: position.Symbol,
          Quantity: Math.abs(parseFloat(position.Quantity)).toString(),
          OrderType: 'Market',
          TradeAction: parseFloat(position.Quantity) > 0 ? 'SELL' : 'BUYTOCOVER',
          TimeInForce: { Duration: 'GTC' }
        };

        const response = await this.apiClient.placeOrder(closeOrder);
        if (response.success) {
          this.logger.info(`Close order placed for ${position.Symbol}: ${closeOrder.Quantity} shares`);
        } else {
          this.logger.error(`Failed to close position ${position.Symbol}:`, response.error);
        }
      } catch (error) {
        this.logger.error(`Error closing position ${position.Symbol}:`, error);
      }
    }
  }

  private async cancelAllPendingOrders(): Promise<void> {
    this.logger.info('Cancelling all pending orders...');
    
    for (const [orderId, order] of this.pendingOrders.entries()) {
      try {
        const response = await this.apiClient.cancelOrder(orderId);
        if (response.success) {
          this.logger.info(`Cancelled order: ${orderId}`);
          this.pendingOrders.delete(orderId);
        } else {
          this.logger.error(`Failed to cancel order ${orderId}:`, response.error);
        }
      } catch (error) {
        this.logger.error(`Error cancelling order ${orderId}:`, error);
      }
    }
  }

  // Console Dashboard
  private displayConsoleDashboard(symbol: string, currentBar: Bar, context: MarketContext): void {
    try {
      // Get MACD values from indicators (matching names from SPX strategy)
      const macdValue = context.indicators.get('macd') as number || 0;
      const macdSignal = context.indicators.get('macd_signal') as number || 0;
      const macdHistogram = context.indicators.get('macd_histogram') as number || 0;
      const macdCrossover = context.indicators.get('macd_crossover') as number || 0;
      
      // Get last few bars
      const bars = this.marketData.get(symbol) || [];
      const lastBars = bars.slice(-5);
      
      // Get strategy status
      const strategy = this.strategyManager.getStrategy('spx-backtest-strategy');
      const hasPosition = strategy ? (strategy as any).currentOptionPosition : false;
      
      // Clear screen and display dashboard
      console.clear();
      console.log('='.repeat(80));
      console.log('🚀 SPX TRADING BOT DASHBOARD');
      console.log('='.repeat(80));
      console.log();
      
      // Current price info
      console.log('📊 CURRENT SPX DATA:');
      console.log(`   Time: ${new Date(currentBar.TimeStamp).toLocaleTimeString()}`);
      console.log(`   Price: $${parseFloat(currentBar.Close).toFixed(2)} (O: ${currentBar.Open} H: ${currentBar.High} L: ${currentBar.Low})`);
      console.log(`   Volume: ${currentBar.TotalVolume}`);
      console.log();
      
      // MACD indicators
      console.log('📈 MACD INDICATORS:');
      console.log(`   MACD Value: ${macdValue.toFixed(4)}`);
      console.log(`   Signal Line: ${macdSignal.toFixed(4)}`);
      console.log(`   Histogram: ${macdHistogram.toFixed(4)} ${macdHistogram > 0 ? '📈' : '📉'}`);
      console.log(`   Crossover: ${macdCrossover === 1 ? '🟢 BULLISH' : macdCrossover === -1 ? '🔴 BEARISH' : '⚪ NONE'}`);
      console.log();
      
      // Strategy status
      console.log('🎯 STRATEGY STATUS:');
      console.log(`   Position: ${hasPosition ? '🟢 IN TRADE' : '⚪ NO POSITION'}`);
      console.log(`   Entry: MACD ≤ -1.0 + Bullish Crossover`);
      console.log(`   Exit: $1.00 profit + momentum shrink OR 20% stop loss OR bearish crossover`);
      console.log(`   Current Status: ${macdValue <= -1.0 && macdCrossover === 1 ? '🚨 BUY SIGNAL!' : '⏳ WAITING'}`);
      console.log();
      
      // Last 5 bars
      console.log('📊 LAST 5 BARS:');
      lastBars.forEach((bar, index) => {
        const time = new Date(bar.TimeStamp).toLocaleTimeString();
        const price = parseFloat(bar.Close).toFixed(2);
        const change = index > 0 ? (parseFloat(bar.Close) - parseFloat(lastBars[index-1].Close)).toFixed(2) : '0.00';
        const arrow = parseFloat(change) > 0 ? '🟢' : parseFloat(change) < 0 ? '🔴' : '⚪';
        console.log(`   ${time}: $${price} (${change >= '0' ? '+' : ''}${change}) ${arrow}`);
      });
      console.log();
      
      // Portfolio info
      console.log('💼 PORTFOLIO:');
      console.log(`   Mode: ${this.config.execution.paperTrading ? '📄 PAPER TRADING' : '💰 LIVE TRADING'}`);
      console.log(`   Accounts: ${this.state.accounts.length}`);
      console.log(`   Active Strategies: ${this.state.activeStrategies.size}`);
      console.log(`   P&L: $${this.state.totalPnL.toFixed(2)}`);
      console.log();
      
      console.log('🔄 Live updating... Press Ctrl+C to stop');
      console.log('='.repeat(80));
      
    } catch (error) {
      console.error('Error displaying dashboard:', error);
    }
  }

  // State accessors
  getState(): BotState {
    return { ...this.state };
  }

  getConfig(): BotConfig {
    return { ...this.config };
  }

  isRunning(): boolean {
    return this.state.status === 'RUNNING';
  }

  // Public method to inject demo data
  public simulateBarData(data: { symbol: string; bar: any }): void {
    this.handleBarUpdate(data);
  }
}