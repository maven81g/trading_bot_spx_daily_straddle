# SPX Daily Options Trading Cloud Function

This Cloud Function runs daily after market close to analyze SPX options trading using the MACD momentum strategy. Results are stored in BigQuery and summaries are emailed via Mailgun.

## Setup Instructions

### 1. Create BigQuery Tables

```bash
# First, create the dataset in BigQuery Console or CLI
bq mk --location=US your-project-id:spx_trading

# Then run the table creation script
bq query --use_legacy_sql=false < create-bigquery-tables.sql
```

**Important:** Replace `your-project-id` with your actual Google Cloud Project ID in the SQL file.

### 2. Environment Variables

Set these in Google Cloud Function environment:

```bash
# TradeStation API
TRADESTATION_REFRESH_TOKEN=your_refresh_token_here

# BigQuery
GOOGLE_CLOUD_PROJECT=your-project-id
BIGQUERY_DATASET=spx_trading

# Mailgun Email
MAILGUN_API_KEY=your_mailgun_api_key
MAILGUN_DOMAIN=your_mailgun_domain.com
EMAIL_TO=recipient@example.com
EMAIL_FROM=trading-bot@your_mailgun_domain.com

# Optional
CLOUD_FUNCTION_VERSION=1.0.0
```

### 3. Deploy Cloud Function

```bash
# Deploy the function
gcloud functions deploy spx-daily-trader \
  --runtime nodejs18 \
  --trigger-http \
  --entry-point main \
  --memory 512MB \
  --timeout 540s \
  --set-env-vars GOOGLE_CLOUD_PROJECT=your-project-id

# Create daily scheduler (runs at 4:30 PM EST / 9:30 PM UTC)
gcloud scheduler jobs create http spx-daily-trading \
  --schedule="30 21 * * 1-5" \
  --uri="https://us-central1-your-project-id.cloudfunctions.net/spx-daily-trader" \
  --http-method=POST \
  --time-zone="America/New_York"
```

### 4. BigQuery Analysis Queries

```sql
-- View daily performance
SELECT * FROM `your-project-id.spx_trading.daily_performance` 
ORDER BY date DESC LIMIT 30;

-- Monthly summary
SELECT * FROM `your-project-id.spx_trading.monthly_summary`;

-- Best performing strikes
SELECT * FROM `your-project-id.spx_trading.strike_performance` 
WHERE total_trades >= 5 
ORDER BY win_rate DESC;
```

## Function Behavior

- **Trigger**: HTTP trigger + Cloud Scheduler (weekdays 4:30 PM EST)
- **Execution**: Fetches current day SPX data and options
- **Strategy**: MACD momentum with 20% stop loss and $1 profit target
- **Storage**: Detailed results → BigQuery
- **Notification**: Summary email → Mailgun
- **Error Handling**: Failures logged and emailed

## Data Schema

### daily_summary table
- Daily P&L, win rate, trade counts
- SPX market data (open, close, daily change)
- Execution metadata

### trades table  
- Individual trade details with entry/exit data
- MACD values at entry and exit
- Hold duration and exit reasons

### Views
- `daily_performance`: Quick daily results
- `monthly_summary`: Aggregate monthly stats
- `strike_performance`: Analysis by strike price

## Email Summary Format

**Subject**: "Daily SPX Options Report - Jul 31, 2025 - P&L: +$236.00"

**Body**: 
- Trade summary table
- Daily statistics
- Link to BigQuery dashboard
- Error notifications (if any)