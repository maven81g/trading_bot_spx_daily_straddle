#!/usr/bin/env python3

"""
SPX Daily Trader - BigQuery Setup Script
Creates tables and views only
"""

from google.cloud import bigquery
from google.cloud.exceptions import NotFound

def create_table(client, project_id, dataset_name, table_name, schema, partition_field=None, cluster_fields=None):
    """Create a BigQuery table with optional partitioning and clustering"""
    table_id = f"{project_id}.{dataset_name}.{table_name}"
    
    try:
        client.get_table(table_id)
        client.delete_table(table_id)
        print(f"Deleted existing table '{table_name}'")
    except NotFound:
        pass
    
    print(f"Creating table: {table_name}")
    
    table = bigquery.Table(table_id, schema=schema)
    
    if partition_field:
        table.time_partitioning = bigquery.TimePartitioning(
            type_=bigquery.TimePartitioningType.DAY,
            field=partition_field
        )
    
    if cluster_fields:
        table.clustering_fields = cluster_fields
    
    table = client.create_table(table)
    print(f"✅ Table '{table_name}' created")
    return True

def get_daily_summary_schema():
    """Get schema for daily_summary table"""
    return [
        bigquery.SchemaField("date", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("strategy", "STRING", mode="REQUIRED", default_value_expression="'MACD_Momentum'"),
        bigquery.SchemaField("trading_day", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("spx_bars_count", "INTEGER", mode="REQUIRED"),
        bigquery.SchemaField("entry_signals", "INTEGER", mode="REQUIRED"),
        bigquery.SchemaField("exit_signals", "INTEGER", mode="REQUIRED"),
        bigquery.SchemaField("total_trades", "INTEGER", mode="REQUIRED"),
        bigquery.SchemaField("winning_trades", "INTEGER", mode="REQUIRED"),
        bigquery.SchemaField("losing_trades", "INTEGER", mode="REQUIRED"),
        bigquery.SchemaField("win_rate", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("total_profit", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("total_loss", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("net_pnl", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("average_win", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("average_loss", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("api_requests_made", "INTEGER", mode="REQUIRED"),
        bigquery.SchemaField("execution_time_seconds", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("market_open_spx", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("market_close_spx", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("spx_daily_change", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("spx_daily_change_percent", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("created_at", "TIMESTAMP", mode="NULLABLE", default_value_expression="CURRENT_TIMESTAMP()"),
        bigquery.SchemaField("cloud_function_version", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("error_message", "STRING", mode="NULLABLE"),
    ]

def get_trades_schema():
    """Get schema for trades table"""
    return [
        bigquery.SchemaField("date", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("trade_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("symbol", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("strike_price", "INTEGER", mode="REQUIRED"),
        bigquery.SchemaField("entry_time", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("entry_time_est", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("entry_price", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("entry_spx_price", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("entry_macd", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("entry_signal", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("entry_histogram", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("exit_time", "TIMESTAMP", mode="NULLABLE"),
        bigquery.SchemaField("exit_time_est", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("exit_price", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("exit_spx_price", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("exit_macd", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("exit_signal", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("exit_histogram", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("hold_duration_minutes", "INTEGER", mode="NULLABLE"),
        bigquery.SchemaField("pnl", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("pnl_percent", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("exit_reason", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("is_winner", "BOOLEAN", mode="REQUIRED"),
        bigquery.SchemaField("trade_sequence", "INTEGER", mode="REQUIRED"),
        bigquery.SchemaField("created_at", "TIMESTAMP", mode="NULLABLE", default_value_expression="CURRENT_TIMESTAMP()"),
    ]

def get_market_data_schema():
    """Get schema for market_data_archive table"""
    return [
        bigquery.SchemaField("date", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("timestamp", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("spx_price", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("spx_open", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("spx_high", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("spx_low", "FLOAT", mode="NULLABLE"),
        bigquery.SchemaField("volume", "INTEGER", mode="NULLABLE"),
        bigquery.SchemaField("created_at", "TIMESTAMP", mode="NULLABLE", default_value_expression="CURRENT_TIMESTAMP()"),
    ]

def create_view(client, project_id, dataset_name, view_name, query):
    """Create a BigQuery view"""
    view_id = f"{project_id}.{dataset_name}.{view_name}"
    
    try:
        client.get_table(view_id)
        client.delete_table(view_id)
        print(f"Deleted existing view '{view_name}'")
    except NotFound:
        pass
    
    print(f"Creating view: {view_name}")
    
    view = bigquery.Table(view_id)
    view.view_query = query
    
    view = client.create_table(view)
    print(f"✅ View '{view_name}' created")
    return True

def create_views(client, project_id, dataset_name):
    """Create all views"""
    print("Creating views...")
    
    # Daily Performance View
    daily_performance_query = f"""
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
    FROM `{project_id}.{dataset_name}.daily_summary`
    ORDER BY date DESC
    """
    
    # Monthly Summary View
    monthly_summary_query = f"""
    SELECT 
      EXTRACT(YEAR FROM date) as year,
      EXTRACT(MONTH FROM date) as month,
      COUNT(*) as trading_days,
      SUM(total_trades) as total_trades,
      SUM(net_pnl) as monthly_pnl,
      AVG(win_rate) as avg_win_rate,
      COUNT(CASE WHEN net_pnl > 0 THEN 1 END) as profitable_days,
      COUNT(CASE WHEN net_pnl < 0 THEN 1 END) as loss_days
    FROM `{project_id}.{dataset_name}.daily_summary`
    GROUP BY year, month
    ORDER BY year DESC, month DESC
    """
    
    # Strike Performance View
    strike_performance_query = f"""
    SELECT 
      strike_price,
      COUNT(*) as total_trades,
      SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) as winning_trades,
      SAFE_DIVIDE(SUM(CASE WHEN is_winner THEN 1 ELSE 0 END), COUNT(*)) as win_rate,
      AVG(pnl) as avg_pnl,
      SUM(pnl) as total_pnl,
      AVG(hold_duration_minutes) as avg_hold_minutes
    FROM `{project_id}.{dataset_name}.trades`
    GROUP BY strike_price
    ORDER BY total_trades DESC
    """
    
    # Create views
    create_view(client, project_id, dataset_name, "daily_performance", daily_performance_query)
    create_view(client, project_id, dataset_name, "monthly_summary", monthly_summary_query)
    create_view(client, project_id, dataset_name, "strike_performance", strike_performance_query)

def main():
    """Main function"""
    project_id = "galvanic-ripsaw-381707"
    dataset_name = "spx_trading"
    
    client = bigquery.Client(project=project_id)
    
    # Create dataset if it doesn't exist
    dataset_id = f"{project_id}.{dataset_name}"
    try:
        client.get_dataset(dataset_id)
        print(f"Dataset '{dataset_name}' already exists")
    except NotFound:
        print(f"Creating dataset '{dataset_name}'...")
        dataset = bigquery.Dataset(dataset_id)
        dataset.location = "US"
        client.create_dataset(dataset)
        print(f"✅ Dataset '{dataset_name}' created")
    
    # Create tables
    create_table(
        client, project_id, dataset_name, "daily_summary",
        get_daily_summary_schema(),
        partition_field="date",
        cluster_fields=["date", "strategy"]
    )
    
    create_table(
        client, project_id, dataset_name, "trades",
        get_trades_schema(),
        partition_field="date", 
        cluster_fields=["date", "symbol", "trade_sequence"]
    )
    
    create_table(
        client, project_id, dataset_name, "market_data_archive",
        get_market_data_schema(),
        partition_field="date",
        cluster_fields=["date", "timestamp"]
    )
    
    # Create views
    create_views(client, project_id, dataset_name)
    
    print("✅ BigQuery setup complete")

if __name__ == "__main__":
    main()