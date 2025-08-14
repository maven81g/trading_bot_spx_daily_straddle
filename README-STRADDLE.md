# SPX Daily Straddle Trading Bot

Automated trading bot for SPX (S&P 500 Index) daily straddle strategy using TradeStation API.

## Strategy Overview

The bot implements a simple but effective daily straddle strategy:

1. **Entry**: At 9:33 AM ET (3 minutes after market open)
   - Gets current SPX price
   - Calculates nearest At-The-Money (ATM) strike price (rounded to nearest $5)
   - Buys both a call and put option at that strike (0DTE - same day expiration)

2. **Exit Conditions**:
   - **Target Hit**: Close when profit reaches target (default 20%)
   - **Stop Loss**: Close if loss exceeds stop (optional, disabled by default)
   - **End of Day**: Close at 3:50 PM ET (10 minutes before market close)

3. **Risk Management**:
   - Paper trading enabled by default
   - Maximum position value limit
   - Single position at a time

## Quick Start

### Local Development

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp env.example .env
   # Edit .env with your TradeStation credentials
   ```

3. **Build and Start**
   ```bash
   npm run build
   npm start
   ```

### Configuration

Key environment variables:

```bash
# TradeStation API
TRADESTATION_CLIENT_ID=your_client_id
TRADESTATION_CLIENT_SECRET=your_secret
TRADESTATION_REFRESH_TOKEN=your_refresh_token
TRADESTATION_SANDBOX=true  # Use sandbox for testing

# Strategy Settings
ENTRY_TIME=09:33           # Entry time (ET)
TARGET_PROFIT=20           # Target profit percentage
# STOP_LOSS=50             # Optional stop loss percentage
EXIT_TIME=15:50           # EOD exit time (ET)
MAX_POSITION_VALUE=10000  # Max dollars per straddle

# Trading Mode
PAPER_TRADING=true        # Paper trading (recommended)
```

## Google Cloud Run Deployment

### Prerequisites

1. **Google Cloud Setup**
   - Create a Google Cloud Project
   - Install Google Cloud SDK
   - Authenticate: `gcloud auth login`

2. **Set Environment**
   ```bash
   export GOOGLE_CLOUD_PROJECT=your-project-id
   ```

### Deploy

1. **Navigate to cloud-run-service directory**
   ```bash
   cd cloud-run-service
   ```

2. **Set up secrets** (first time only)
   ```bash
   ./setup-secrets.sh
   ```

3. **Deploy the service**
   ```bash
   ./deploy.sh
   ```

### Cloud Run Management

The deployed service provides HTTP endpoints:

- **Health Check**: `GET /health`
- **Start Bot**: `POST /start`
- **Stop Bot**: `POST /stop`
- **Status**: `GET /status`

Example usage:
```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe spx-straddle-bot --region=us-central1 --format="value(status.url)")

# Check health
curl $SERVICE_URL/health

# Start bot
curl -X POST $SERVICE_URL/start

# Check status
curl $SERVICE_URL/status

# Stop bot
curl -X POST $SERVICE_URL/stop
```

## Monitoring and Logs

### Local Logs
```bash
tail -f logs/straddle-bot.log
```

### Cloud Run Logs
```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=spx-straddle-bot" --limit 50
```

### Status Dashboard

When running locally, the bot displays a live dashboard every 2 minutes:

```
╔══════════════════════════════════════════════════════════════╗
║                  🎯 STRADDLE BOT STATUS                       ║
╠══════════════════════════════════════════════════════════════╣
║ ⏰ Time: 14:35:22 ET | Uptime: 2h 15m                        ║
║ 📈 Trades: 1   | Daily P&L: $125.50                          ║
╠══════════════════════════════════════════════════════════════╣
║ 🎯 ACTIVE STRADDLE:                                          ║
║   Strike: 5450 Straddle                                      ║
║   Entry: $45.20 | Current: $52.30                           ║
║   P&L: $710.00 (15.7%)                                      ║
║   Hold Time: 125 minutes                                     ║
╚══════════════════════════════════════════════════════════════╝
```

## Backtest

Use the included backtest script to analyze historical performance:

```bash
# Run backtest for last 40 days with 20% target and 50% stop
node spx-straddle-backtest.js 40 20 50

# Run with default settings (40 days, 20% target, no stop)
npm run backtest
```

## Data Storage (Optional)

Configure BigQuery for trade storage:

```bash
# In .env
GOOGLE_CLOUD_PROJECT=your-project-id
BIGQUERY_DATASET=spx_straddle
```

The bot will automatically create and populate a `straddle_trades` table with:
- Trade entry/exit times
- Strike prices and premiums
- P&L and performance metrics
- Exit reasons

## Safety Features

1. **Paper Trading**: Enabled by default - no real money at risk
2. **Single Position**: Only one straddle open at a time
3. **Time-based Entry**: Only enters during specified time window
4. **Automatic Exit**: Always exits before market close
5. **Position Limits**: Maximum dollar exposure limits
6. **Error Handling**: Comprehensive error handling and logging

## Support

For issues and questions:
- Check logs for error details
- Verify TradeStation API credentials
- Ensure market hours operation
- Review configuration settings

## Risk Warning

⚠️ **Trading involves substantial risk of loss. This software is for educational purposes. Always use paper trading first. Never risk more than you can afford to lose.**