# Trading Bot Application

A sophisticated automated trading bot for the TradeStation platform with enhanced SPX options backtesting capabilities, featuring strategy management, risk controls, and hybrid data architecture.

## Table of Contents
- [SPX Options Backtesting](#spx-options-backtesting) ⭐ **Primary Feature**
- [Setup and Installation](#setup-and-installation)
- [Live Trading Bot](#live-trading-bot)
- [Cloud Functions](#cloud-functions)
- [API Reference](#api-reference)

## SPX Options Backtesting

⭐ **Primary Feature**: Enhanced SPX backtesting engine with hybrid data architecture and negative crossover exits.

### Overview

The SPX Options Backtesting system (`spx-20day-backtest.js`) provides comprehensive historical analysis of SPX same-day expiration (0DTE) options trading with the following key features:

- **🔄 Hybrid Data Sources**: TradeStation for SPX index + BigQuery for expired options (Aug 4, 2025+)
- **📈 Enhanced MACD Strategy**: Negative crossover exits prevent waiting for 20% stop losses
- **🎯 Smart Strike Fallback**: Uses closest available strike when exact match unavailable  
- **📊 Comprehensive Analytics**: Detailed exit reason tracking and performance metrics
- **⚡ On-Demand Fetching**: Only queries option data when trade signals occur

### Quick Start

```bash
# Install dependencies
npm install

# Run 20-day backtest
node spx-20day-backtest.js

# Run single day backtest
node spx-20day-backtest.js --date=2025-08-04
```

### Environment Setup

Create a `.env` file with your TradeStation credentials:

```bash
# TradeStation API Configuration (Required)
TRADESTATION_CLIENT_ID=your_client_id
TRADESTATION_CLIENT_SECRET=your_client_secret  
TRADESTATION_REFRESH_TOKEN=your_refresh_token

# Optional TradeStation Configuration
TRADESTATION_BASE_URL=https://sim-api.tradestation.com
TRADESTATION_AUTH_URL=https://signin.tradestation.com
```

### Command Line Usage

| Command | Description | Example |
|---------|-------------|---------|
| `node spx-20day-backtest.js` | Run 20-day backtest | Full analysis |
| `--date=YYYY-MM-DD` | Single day backtest | `--date=2025-08-04` |
| `--single-day=YYYY-MM-DD` | Alternative single day | `--single-day=2025-08-05` |

### Strategy Features

#### Enhanced MACD Strategy
- **Entry Signal**: MACD < -2.0 with bullish crossover
- **Priority Exit Logic** (in order):
  1. **🔄 Negative Crossover** (NEW): Immediate exit on bearish MACD crossover
  2. **🛑 Stop Loss**: 20% loss threshold
  3. **💰 Profit Target**: $1 profit + momentum shrinking

#### Data Sources
- **BigQuery**: Aug 4, 2025+ (25 strikes per day, expired options)
- **TradeStation**: SPX index data + pre-Aug 4, 2025 options (when available)
- **Fallback Logic**: Closest available strike when exact strike missing

### Sample Output

```
🔐 Enhanced Authentication (TradeStation + BigQuery)
✅ BigQuery connection successful - expired options data available
✅ TradeStation authentication successful

📊 Processing Day 1/20: Mon Aug 04 2025
   ✅ Loaded 390 SPX bars from TradeStation
   📊 Using BigQuery for option data
   🎯 Found 25 available strikes in BigQuery
   💰 Day P&L: $150.00 (2 trades) [BigQuery]

📄 ENHANCED BACKTEST COMPLETE
Net P&L: $2,450.00
Total Trades: 45
Win Rate: 67.5%
Negative Crossover Exits: 18 (40.0%)
BigQuery Days: 5, TradeStation Days: 15
```

### Reports

Results are automatically saved to `backtest_results/spx_20day_backtest_YYYY-MM-DD.txt` with:
- **Exit Reason Breakdown**: Percentage by exit method
- **Data Source Summary**: BigQuery vs TradeStation usage
- **Trade Details**: Each trade with exit reason and data source
- **Strike Simulation Warnings**: When closest available strike was used

### Troubleshooting

#### Missing Environment Variables
```bash
# Check if variables are set
echo $TRADESTATION_REFRESH_TOKEN
echo $TRADESTATION_CLIENT_ID
echo $TRADESTATION_CLIENT_SECRET
```

#### Authentication Issues
- Ensure refresh token is valid and not expired
- Check TradeStation API credentials
- Verify `.env` file is in project root directory

#### Data Availability
- **Aug 4, 2025+**: Uses BigQuery option data automatically
- **Before Aug 4, 2025**: Uses TradeStation (limited expired options)
- **Weekends/Holidays**: No trading data available

## Setup and Installation

### Prerequisites
- Node.js >= 16.0.0
- TradeStation API account with OAuth credentials
- NPM or Yarn package manager

### Installation Steps

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd trading_bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your TradeStation API credentials
   ```

4. **Run the SPX backtest**
   ```bash
   node spx-20day-backtest.js
   ```

## Live Trading Bot

The application also includes a full-featured live trading bot with the following components:

### Core Components

#### 1. **TradingBot** (`src/bot.ts`)
The main orchestrator that coordinates all components:
- **State Management**: Tracks bot status, accounts, positions, and performance
- **Event Handling**: Processes market data and strategy signals
- **Order Execution**: Handles both paper and live trading
- **Lifecycle Management**: Startup, shutdown, and error handling

#### 2. **TradeStation API Client** (`src/api/client.ts`)
Handles all communication with TradeStation:
- **Authentication**: OAuth2 flow implementation
- **Account Management**: Fetches accounts, balances, positions
- **Order Management**: Places, modifies, and cancels orders
- **Market Data**: Historical data retrieval

#### 3. **Strategy Manager** (`src/strategies/strategy-manager.ts`)
Orchestrates multiple trading strategies:
- **Strategy Loading**: Dynamically loads strategy configurations
- **Signal Generation**: Processes market data through strategies
- **Signal Aggregation**: Combines signals from multiple strategies
- **Performance Tracking**: Monitors strategy effectiveness

#### 4. **Risk Manager** (`src/risk/risk-manager.ts`)
Enforces trading risk controls:
- **Position Limits**: Maximum positions per symbol and total
- **Loss Limits**: Daily loss and drawdown thresholds
- **Signal Validation**: Pre-trade risk checks
- **Real-time Monitoring**: Continuous risk assessment

### Live Bot Usage

```bash
# Development mode with hot reload
npm run dev

# Production mode
npm start
```

### Configuration

Environment variables for live trading (`.env`):

```bash
# TradeStation API Configuration
TRADESTATION_CLIENT_ID=your_client_id
TRADESTATION_CLIENT_SECRET=your_client_secret
TRADESTATION_REDIRECT_URI=http://localhost:3000/callback
TRADESTATION_BASE_URL=https://sim-api.tradestation.com
TRADESTATION_AUTH_URL=https://signin.tradestation.com/authorize

# Trading Configuration
PAPER_TRADING=true                    # true for simulation, false for live trading
ORDER_TIMEOUT=30000                   # Order timeout in milliseconds
MAX_SLIPPAGE=0.01                    # Maximum allowed slippage (1%)

# Risk Management
MAX_DAILY_LOSS=1000                  # Maximum daily loss in dollars
MAX_DRAWDOWN=0.10                    # Maximum drawdown (10%)
MAX_POSITIONS_PER_SYMBOL=3           # Maximum positions per symbol
MAX_TOTAL_POSITIONS=10               # Maximum total positions

# Logging
LOG_LEVEL=info                       # error, warn, info, debug
LOG_FILE=logs/trading-bot.log        # Log file path (optional)
```

## Cloud Functions

The `cloud-function/` directory contains Google Cloud Function implementations for:
- **Automated Daily Trading**: `spx-daily-reporter.js`
- **BigQuery Integration**: `bigquery-client.js`
- **Email Notifications**: `email-client.js`
- **Secret Management**: `secret-manager-client.js`

### Deployment

```bash
cd cloud-function
./deploy.sh
```

## API Reference

### TradingBot Class Methods

#### `start(): Promise<void>`
Starts the trading bot with full initialization sequence.

#### `stop(): Promise<void>`
Gracefully stops the bot, closing positions and connections.

#### `getState(): BotState`
Returns current bot state including status, positions, and performance.

### Events

The TradingBot class extends EventEmitter and emits the following events:

- `started`: Bot successfully started
- `stopped`: Bot stopped gracefully
- `error`: Error occurred
- `heartbeat`: Periodic status update (every 30 seconds)
- `riskViolation`: Risk limit violation detected

### Strategy Interface

Custom strategies must implement the Strategy interface:

```typescript
interface Strategy {
  onBar(symbol: string, bar: Bar, context: MarketContext): Promise<Signal[]>;
  onQuote(symbol: string, quote: Quote, context: MarketContext): Promise<Signal[]>;
  onOrderFilled(symbol: string, order: any, context: MarketContext): Promise<void>;
}
```

For more detailed API documentation, see the TypeScript interfaces in `src/types/`.

## Project Structure

```
trading_bot/
├── spx-20day-backtest.js          # Primary SPX backtesting engine
├── bigquery-option-data-client.js # BigQuery integration for expired options
├── package.json                   # Dependencies and scripts
├── README.md                      # This documentation
├── backtest_results/              # Generated backtest reports
├── cloud-function/                # Google Cloud Function implementations
├── config/                        # Strategy and configuration files
├── src/                          # Live trading bot source code
│   ├── api/                      # TradeStation API clients
│   ├── strategies/               # Trading strategies
│   ├── risk/                     # Risk management
│   └── types/                    # TypeScript interfaces
└── dist/                         # Compiled TypeScript output
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

ISC License - see package.json for details