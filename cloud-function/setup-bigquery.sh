#!/bin/bash

# SPX Daily Trader - BigQuery Setup Script
# Creates dataset and tables for storing trading data

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📊 SPX Daily Trader - BigQuery Setup${NC}"
echo "=========================================="

# Check if GOOGLE_CLOUD_PROJECT is set
if [ -z "$GOOGLE_CLOUD_PROJECT" ]; then
    echo -e "${RED}❌ Error: GOOGLE_CLOUD_PROJECT is not set${NC}"
    echo "Please set your Google Cloud project ID:"
    echo "export GOOGLE_CLOUD_PROJECT=your-project-id"
    exit 1
fi

echo -e "${GREEN}✅ Using project: $GOOGLE_CLOUD_PROJECT${NC}"

# Set dataset name
DATASET_NAME="spx_trading"
LOCATION="US"

# Check if dataset exists
echo ""
echo -e "${YELLOW}📊 Checking if dataset exists...${NC}"
if bq ls --project_id=$GOOGLE_CLOUD_PROJECT $DATASET_NAME >/dev/null 2>&1; then
    echo -e "${YELLOW}Dataset '$DATASET_NAME' already exists${NC}"
    read -p "Do you want to continue and create tables? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Exiting..."
        exit 0
    fi
else
    echo -e "${YELLOW}Creating dataset '$DATASET_NAME'...${NC}"
    bq mk --location=$LOCATION --project_id=$GOOGLE_CLOUD_PROJECT $DATASET_NAME
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Dataset created successfully${NC}"
    else
        echo -e "${RED}❌ Failed to create dataset${NC}"
        exit 1
    fi
fi

# Function to create a table
create_table() {
    local table_name=$1
    local schema_file=$2
    
    echo ""
    echo -e "${YELLOW}📋 Creating table: $table_name${NC}"
    
    # Check if table exists
    if bq ls --project_id=$GOOGLE_CLOUD_PROJECT $DATASET_NAME | grep -q "^$table_name"; then
        echo -e "${YELLOW}Table '$table_name' already exists${NC}"
        read -p "Do you want to delete and recreate it? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Deleting existing table..."
            bq rm -f --project_id=$GOOGLE_CLOUD_PROJECT $DATASET_NAME.$table_name
        else
            echo "Skipping $table_name"
            return
        fi
    fi
    
    # Create the table using the SQL file
    echo "Creating table $table_name..."
    bq query --project_id=$GOOGLE_CLOUD_PROJECT --use_legacy_sql=false < $schema_file
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Table '$table_name' created successfully${NC}"
    else
        echo -e "${RED}❌ Failed to create table '$table_name'${NC}"
        exit 1
    fi
}

# Create individual SQL files for each table
echo ""
echo -e "${YELLOW}📝 Creating table schema files...${NC}"

# Daily Summary Table SQL
cat > daily_summary.sql << EOF
CREATE TABLE \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.daily_summary\` (
  date DATE NOT NULL,
  strategy STRING NOT NULL DEFAULT 'MACD_Momentum',
  trading_day STRING NOT NULL,
  spx_bars_count INT64 NOT NULL,
  entry_signals INT64 NOT NULL,
  exit_signals INT64 NOT NULL,
  total_trades INT64 NOT NULL,
  winning_trades INT64 NOT NULL,
  losing_trades INT64 NOT NULL,
  win_rate FLOAT64 NOT NULL,
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
  cloud_function_version STRING,
  error_message STRING
)
PARTITION BY date
CLUSTER BY date, strategy;
EOF

# Trades Table SQL
cat > trades.sql << EOF
CREATE TABLE \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.trades\` (
  date DATE NOT NULL,
  trade_id STRING NOT NULL,
  symbol STRING NOT NULL,
  strike_price INT64 NOT NULL,
  entry_time TIMESTAMP NOT NULL,
  entry_time_est STRING NOT NULL,
  entry_price FLOAT64 NOT NULL,
  entry_spx_price FLOAT64 NOT NULL,
  entry_macd FLOAT64 NOT NULL,
  entry_signal FLOAT64 NOT NULL,
  entry_histogram FLOAT64 NOT NULL,
  exit_time TIMESTAMP,
  exit_time_est STRING,
  exit_price FLOAT64,
  exit_spx_price FLOAT64,
  exit_macd FLOAT64,
  exit_signal FLOAT64,
  exit_histogram FLOAT64,
  hold_duration_minutes INT64,
  pnl FLOAT64 NOT NULL,
  pnl_percent FLOAT64 NOT NULL,
  exit_reason STRING NOT NULL,
  is_winner BOOL NOT NULL,
  trade_sequence INT64 NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY date
CLUSTER BY date, symbol, trade_sequence;
EOF

# Market Data Archive Table SQL
cat > market_data_archive.sql << EOF
CREATE TABLE \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.market_data_archive\` (
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
EOF

echo -e "${GREEN}✅ Schema files created${NC}"

# Create tables
create_table "daily_summary" "daily_summary.sql"
create_table "trades" "trades.sql"
create_table "market_data_archive" "market_data_archive.sql"

# Create views
echo ""
echo -e "${YELLOW}📊 Creating views...${NC}"

# Daily Performance View
echo "Creating daily_performance view..."
bq query --project_id=$GOOGLE_CLOUD_PROJECT --use_legacy_sql=false << EOF
CREATE VIEW \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.daily_performance\` AS
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
FROM \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.daily_summary\`
ORDER BY date DESC;
EOF

# Monthly Summary View
echo "Creating monthly_summary view..."
bq query --project_id=$GOOGLE_CLOUD_PROJECT --use_legacy_sql=false << EOF
CREATE VIEW \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.monthly_summary\` AS
SELECT 
  EXTRACT(YEAR FROM date) as year,
  EXTRACT(MONTH FROM date) as month,
  COUNT(*) as trading_days,
  SUM(total_trades) as total_trades,
  SUM(net_pnl) as monthly_pnl,
  AVG(win_rate) as avg_win_rate,
  COUNT(CASE WHEN net_pnl > 0 THEN 1 END) as profitable_days,
  COUNT(CASE WHEN net_pnl < 0 THEN 1 END) as loss_days
FROM \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.daily_summary\`
GROUP BY year, month
ORDER BY year DESC, month DESC;
EOF

# Strike Performance View
echo "Creating strike_performance view..."
bq query --project_id=$GOOGLE_CLOUD_PROJECT --use_legacy_sql=false << EOF
CREATE VIEW \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.strike_performance\` AS
SELECT 
  strike_price,
  COUNT(*) as total_trades,
  SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) as winning_trades,
  SAFE_DIVIDE(SUM(CASE WHEN is_winner THEN 1 ELSE 0 END), COUNT(*)) as win_rate,
  AVG(pnl) as avg_pnl,
  SUM(pnl) as total_pnl,
  AVG(hold_duration_minutes) as avg_hold_minutes
FROM \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.trades\`
GROUP BY strike_price
ORDER BY total_trades DESC;
EOF

echo -e "${GREEN}✅ Views created successfully${NC}"

# Clean up temporary files
echo ""
echo -e "${YELLOW}🧹 Cleaning up temporary files...${NC}"
rm -f daily_summary.sql trades.sql market_data_archive.sql

# Show created objects
echo ""
echo -e "${GREEN}🎉 BigQuery setup completed successfully!${NC}"
echo ""
echo -e "${BLUE}📋 Created objects:${NC}"
echo "Dataset: $DATASET_NAME"
echo "Tables:"
echo "  - daily_summary (partitioned by date)"
echo "  - trades (partitioned by date)"  
echo "  - market_data_archive (partitioned by date)"
echo "Views:"
echo "  - daily_performance"
echo "  - monthly_summary"
echo "  - strike_performance"

echo ""
echo -e "${BLUE}🔧 Next Steps:${NC}"
echo "1. Verify tables in BigQuery Console:"
echo "   https://console.cloud.google.com/bigquery?project=$GOOGLE_CLOUD_PROJECT"
echo ""
echo "2. Test a query:"
echo "   SELECT * FROM \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.daily_performance\` LIMIT 10"
echo ""
echo "3. Deploy your Cloud Function:"
echo "   ./deploy.sh"
echo ""
echo "4. The function will automatically populate these tables with trading data"

echo ""
echo -e "${YELLOW}📊 Sample Queries:${NC}"
echo "# View recent performance"
echo "SELECT * FROM \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.daily_performance\` ORDER BY date DESC LIMIT 30;"
echo ""
echo "# Monthly summary"  
echo "SELECT * FROM \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.monthly_summary\`;"
echo ""
echo "# Best strikes"
echo "SELECT * FROM \`$GOOGLE_CLOUD_PROJECT.$DATASET_NAME.strike_performance\` WHERE total_trades >= 5 ORDER BY win_rate DESC;"