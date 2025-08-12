const { BigQuery } = require('@google-cloud/bigquery');

/**
 * BigQuery client for storing SPX trading data
 */
class BigQueryClient {
    constructor(projectId, dataset) {
        this.projectId = projectId;
        this.dataset = dataset;
        this.bigquery = new BigQuery({ projectId });
        
        console.log(`📊 BigQuery client initialized: ${projectId}.${dataset}`);
    }
    
    /**
     * Store daily summary data
     * @param {Object} summaryData - Daily summary data
     */
    async storeDailySummary(summaryData) {
        console.log('💾 Storing daily summary to BigQuery...');
        
        const table = this.bigquery.dataset(this.dataset).table('daily_summary');
        
        const row = {
            date: summaryData.date,
            strategy: summaryData.strategy || 'MACD_Momentum',
            trading_day: summaryData.trading_day,
            spx_bars_count: summaryData.spx_bars_count,
            entry_signals: summaryData.entry_signals,
            exit_signals: summaryData.exit_signals,
            total_trades: summaryData.total_trades,
            winning_trades: summaryData.winning_trades,
            losing_trades: summaryData.losing_trades,
            win_rate: summaryData.win_rate,
            total_profit: summaryData.total_profit,
            total_loss: summaryData.total_loss,
            net_pnl: summaryData.net_pnl,
            average_win: summaryData.average_win,
            average_loss: summaryData.average_loss,
            api_requests_made: summaryData.api_requests_made,
            execution_time_seconds: summaryData.execution_time_seconds,
            market_open_spx: summaryData.market_open_spx,
            market_close_spx: summaryData.market_close_spx,
            spx_daily_change: summaryData.spx_daily_change,
            spx_daily_change_percent: summaryData.spx_daily_change_percent,
            cloud_function_version: summaryData.cloud_function_version,
            error_message: summaryData.error_message || null
        };
        
        try {
            await table.insert([row]);
            console.log(`✅ Daily summary stored for ${summaryData.date}`);
            return true;
        } catch (error) {
            console.error('❌ Failed to store daily summary:', error);
            throw error;
        }
    }
    
    /**
     * Store individual trades data
     * @param {Array} trades - Array of trade objects
     */
    async storeTrades(trades) {
        console.log(`💾 Storing ${trades.length} trades to BigQuery...`);
        
        if (trades.length === 0) {
            console.log('ℹ️ No trades to store');
            return true;
        }
        
        const table = this.bigquery.dataset(this.dataset).table('trades');
        
        const rows = trades.map(trade => ({
            date: trade.date,
            trade_id: trade.trade_id,
            symbol: trade.symbol,
            strike_price: trade.strike_price,
            // Entry details
            entry_time: trade.entry_time,
            entry_time_est: trade.entry_time_est,
            entry_price: trade.entry_price,
            entry_spx_price: trade.entry_spx_price,
            entry_macd: trade.entry_macd,
            entry_signal: trade.entry_signal,
            entry_histogram: trade.entry_histogram,
            // Exit details
            exit_time: trade.exit_time,
            exit_time_est: trade.exit_time_est,
            exit_price: trade.exit_price,
            exit_spx_price: trade.exit_spx_price,
            exit_macd: trade.exit_macd,
            exit_signal: trade.exit_signal,
            exit_histogram: trade.exit_histogram,
            // Trade results
            hold_duration_minutes: trade.hold_duration_minutes,
            pnl: trade.pnl,
            pnl_percent: trade.pnl_percent,
            exit_reason: trade.exit_reason,
            is_winner: trade.is_winner,
            trade_sequence: trade.trade_sequence
        }));
        
        try {
            await table.insert(rows);
            console.log(`✅ ${trades.length} trades stored successfully`);
            return true;
        } catch (error) {
            console.error('❌ Failed to store trades:', error);
            throw error;
        }
    }
    
    /**
     * Store market data archive (optional)
     * @param {Array} marketData - Array of SPX price data
     */
    async storeMarketData(marketData) {
        console.log(`💾 Storing ${marketData.length} market data points to BigQuery...`);
        
        if (marketData.length === 0) {
            console.log('ℹ️ No market data to store');
            return true;
        }
        
        const table = this.bigquery.dataset(this.dataset).table('market_data_archive');
        
        const rows = marketData.map(data => ({
            date: data.date,
            timestamp: data.timestamp,
            spx_price: data.spx_price,
            spx_open: data.spx_open,
            spx_high: data.spx_high,
            spx_low: data.spx_low,
            volume: data.volume
        }));
        
        try {
            // Insert in batches of 1000 to avoid limits
            const batchSize = 1000;
            for (let i = 0; i < rows.length; i += batchSize) {
                const batch = rows.slice(i, i + batchSize);
                await table.insert(batch);
                console.log(`✅ Inserted market data batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(rows.length/batchSize)}`);
            }
            
            console.log(`✅ All ${marketData.length} market data points stored successfully`);
            return true;
        } catch (error) {
            console.error('❌ Failed to store market data:', error);
            throw error;
        }
    }
    
    /**
     * Query recent daily summaries for context
     * @param {number} days - Number of recent days to query
     * @returns {Array} Recent daily summaries
     */
    async getRecentSummaries(days = 30) {
        console.log(`📊 Querying last ${days} daily summaries...`);
        
        const query = `
            SELECT 
                date,
                net_pnl,
                win_rate,
                total_trades,
                spx_daily_change_percent
            FROM \`${this.projectId}.${this.dataset}.daily_summary\`
            WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
            ORDER BY date DESC
        `;
        
        try {
            const [rows] = await this.bigquery.query(query);
            console.log(`✅ Retrieved ${rows.length} recent summaries`);
            return rows;
        } catch (error) {
            console.error('❌ Failed to query recent summaries:', error);
            return [];
        }
    }
    
    /**
     * Get monthly performance statistics
     * @returns {Array} Monthly performance data
     */
    async getMonthlyPerformance() {
        console.log('📊 Querying monthly performance...');
        
        const query = `
            SELECT * FROM \`${this.projectId}.${this.dataset}.monthly_summary\`
            ORDER BY year DESC, month DESC
            LIMIT 12
        `;
        
        try {
            const [rows] = await this.bigquery.query(query);
            console.log(`✅ Retrieved ${rows.length} monthly summaries`);
            return rows;
        } catch (error) {
            console.error('❌ Failed to query monthly performance:', error);
            return [];
        }
    }
}

module.exports = { BigQueryClient };