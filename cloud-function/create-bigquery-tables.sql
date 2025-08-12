-- BigQuery Tables for SPX Daily Options Trading
-- Run these commands in BigQuery Console or using bq CLI

-- Dataset creation (run first)
-- CREATE SCHEMA `your-project-id.spx_trading` OPTIONS(location="US");

-- Table 1: Daily Summary Table
CREATE TABLE `your-project-id.spx_trading.daily_summary` (
  date DATE NOT NULL,
  strategy STRING NOT NULL DEFAULT 'MACD_Momentum',
  trading_day STRING NOT NULL, -- e.g., "Mon Jul 31 2025"
  spx_bars_count INT64 NOT NULL,
  entry_signals INT64 NOT NULL,
  exit_signals INT64 NOT NULL,
  total_trades INT64 NOT NULL,
  winning_trades INT64 NOT NULL,
  losing_trades INT64 NOT NULL,
  win_rate FLOAT64 NOT NULL, -- percentage as decimal (0.143 for 14.3%)
  total_profit FLOAT64 NOT NULL,
  total_loss FLOAT64 NOT NULL,
  net_pnl FLOAT64 NOT NULL,
  average_win FLOAT64,
  average_loss FLOAT64,
  api_requests_made INT64 NOT NULL,
  execution_time_seconds FLOAT64,
  market_open_spx FLOAT64,
  market_close_spx FLOAT64,
  spx_daily_change FLOAT64,
  spx_daily_change_percent FLOAT64,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  -- Metadata
  cloud_function_version STRING,
  error_message STRING -- NULL if successful
)
PARTITION BY date
CLUSTER BY date, strategy;

-- Table 2: Individual Trades Table  
CREATE TABLE `your-project-id.spx_trading.trades` (
  date DATE NOT NULL,
  trade_id STRING NOT NULL, -- e.g., "20250731_001"
  symbol STRING NOT NULL, -- e.g., "SPXW 250731C6390"
  strike_price INT64 NOT NULL, -- e.g., 6390
  -- Entry details
  entry_time TIMESTAMP NOT NULL,
  entry_time_est STRING NOT NULL, -- formatted EST time
  entry_price FLOAT64 NOT NULL,
  entry_spx_price FLOAT64 NOT NULL,
  entry_macd FLOAT64 NOT NULL,
  entry_signal FLOAT64 NOT NULL,
  entry_histogram FLOAT64 NOT NULL,
  -- Exit details  
  exit_time TIMESTAMP,
  exit_time_est STRING,
  exit_price FLOAT64,
  exit_spx_price FLOAT64,
  exit_macd FLOAT64,
  exit_signal FLOAT64,
  exit_histogram FLOAT64,
  -- Trade results
  hold_duration_minutes INT64,
  pnl FLOAT64 NOT NULL,
  pnl_percent FLOAT64 NOT NULL, -- percentage return
  exit_reason STRING NOT NULL, -- "Stop loss triggered (20% loss)" or "Profit target reached AND momentum shrinking"
  is_winner BOOL NOT NULL,
  -- Trade sequence
  trade_sequence INT64 NOT NULL, -- 1, 2, 3, etc. for the day
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY date
CLUSTER BY date, symbol, trade_sequence;

-- Table 3: Market Data Archive (Optional - for debugging/analysis)
CREATE TABLE `your-project-id.spx_trading.market_data_archive` (
  date DATE NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  spx_price FLOAT64 NOT NULL,
  spx_open FLOAT64,
  spx_high FLOAT64,
  spx_low FLOAT64,
  volume INT64,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY date
CLUSTER BY date, timestamp;

-- Views for common queries
-- Daily Performance View
CREATE VIEW `your-project-id.spx_trading.daily_performance` AS
SELECT 
  date,
  net_pnl,
  win_rate,
  total_trades,
  spx_daily_change_percent,
  CASE 
    WHEN net_pnl > 0 THEN 'Profitable'
    WHEN net_pnl < 0 THEN 'Loss'
    ELSE 'Breakeven'
  END as day_result
FROM `your-project-id.spx_trading.daily_summary`
ORDER BY date DESC;

-- Monthly Summary View
CREATE VIEW `your-project-id.spx_trading.monthly_summary` AS
SELECT 
  EXTRACT(YEAR FROM date) as year,
  EXTRACT(MONTH FROM date) as month,
  COUNT(*) as trading_days,
  SUM(total_trades) as total_trades,
  SUM(net_pnl) as monthly_pnl,
  AVG(win_rate) as avg_win_rate,
  COUNT(CASE WHEN net_pnl > 0 THEN 1 END) as profitable_days,
  COUNT(CASE WHEN net_pnl < 0 THEN 1 END) as loss_days
FROM `your-project-id.spx_trading.daily_summary`
GROUP BY year, month
ORDER BY year DESC, month DESC;

-- Trade Performance by Strike Analysis
CREATE VIEW `your-project-id.spx_trading.strike_performance` AS
SELECT 
  strike_price,
  COUNT(*) as total_trades,
  SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) as winning_trades,
  SAFE_DIVIDE(SUM(CASE WHEN is_winner THEN 1 ELSE 0 END), COUNT(*)) as win_rate,
  AVG(pnl) as avg_pnl,
  SUM(pnl) as total_pnl,
  AVG(hold_duration_minutes) as avg_hold_minutes
FROM `your-project-id.spx_trading.trades`
GROUP BY strike_price
ORDER BY total_trades DESC;