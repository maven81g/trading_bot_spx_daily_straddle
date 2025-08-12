const { BigQuery } = require('@google-cloud/bigquery');

/**
 * BigQuery client for retrieving stored option data for backtesting
 * Handles expired options data that TradeStation no longer provides
 * Uses table: galvanic-ripsaw-381707.spx_all.spx_option_call_barcharts
 * 
 * Schema:
 * - OptionSymbol (STRING): e.g., "SPXW 250804C6390"
 * - Strike (INT64): Strike price
 * - CreatedDate (DATE): Trading date
 * - High/Low/Open/Close (FLOAT64): OHLC prices
 * - TimeStamp (TIMESTAMP): Bar timestamp
 * - TotalVolume (INT64): Volume
 * - Other fields: Various tick/volume statistics
 */
class BigQueryOptionDataClient {
    constructor() {
        this.projectId = 'galvanic-ripsaw-381707';
        this.dataset = 'spx_all';
        this.table = 'spx_option_call_barcharts';
        this.bigquery = new BigQuery({ projectId: this.projectId });
        this.cache = new Map();
        
        console.log(`📊 BigQuery Option Data Client initialized: ${this.projectId}.${this.dataset}.${this.table}`);
    }
    
    /**
     * Check if date is within BigQuery data range (Aug 4, 2025 forward)
     * @param {Date} date - Date to check
     * @returns {boolean} True if data should be available in BigQuery
     */
    isDataAvailableInBigQuery(date) {
        const cutoffDate = new Date('2025-08-04');
        return date >= cutoffDate;
    }
    
    /**
     * Get available strikes for a specific date from BigQuery
     * @param {Date} date - Trading date
     * @returns {Array} Array of available strikes
     */
    async getAvailableStrikes(date) {
        const dateStr = this.formatDate(date);
        const cacheKey = `strikes_${dateStr}`;
        
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }
        
        const query = `
            SELECT DISTINCT Strike as strike_price
            FROM \`${this.projectId}.${this.dataset}.${this.table}\`
            WHERE CreatedDate = @date
            ORDER BY Strike
        `;
        
        try {
            const [rows] = await this.bigquery.query({
                query,
                params: { date: dateStr }
            });
            
            const strikes = rows.map(row => row.strike_price);
            this.cache.set(cacheKey, strikes);
            
            console.log(`📊 Found ${strikes.length} available strikes for ${dateStr}: [${strikes.slice(0, 3).join(', ')}${strikes.length > 3 ? '...' : ''}]`);
            return strikes;
        } catch (error) {
            console.error(`❌ Failed to get available strikes for ${dateStr}:`, error);
            return [];
        }
    }
    
    /**
     * Get option bar data for a specific symbol and date
     * @param {string} optionSymbol - Option symbol (e.g., "SPXW 250804C6390")
     * @param {Date} date - Trading date
     * @returns {Object} Option data result
     */
    async getOptionData(optionSymbol, date) {
        const dateStr = this.formatDate(date);
        const cacheKey = `${optionSymbol}_${dateStr}`;
        
        if (this.cache.has(cacheKey)) {
            console.log(`📋 Using cached option data for ${optionSymbol}`);
            return this.cache.get(cacheKey);
        }
        
        // Extract strike price from symbol
        const strikeMatch = optionSymbol.match(/C(\d+)$/);
        if (!strikeMatch) {
            console.error(`❌ Invalid option symbol format: ${optionSymbol}`);
            return { success: false, error: 'Invalid symbol format', data: [] };
        }
        
        const strikePrice = parseInt(strikeMatch[1]);
        
        const query = `
            SELECT 
                TimeStamp,
                Open,
                High,
                Low,
                Close,
                TotalVolume as Volume,
                OptionSymbol
            FROM \`${this.projectId}.${this.dataset}.${this.table}\`
            WHERE CreatedDate = @date 
            AND Strike = @strike_price
            ORDER BY TimeStamp
        `;
        
        try {
            const [rows] = await this.bigquery.query({
                query,
                params: { 
                    date: dateStr, 
                    strike_price: strikePrice 
                }
            });
            
            if (rows.length === 0) {
                console.log(`⚠️ No option data found for ${optionSymbol} on ${dateStr}`);
                const result = { 
                    success: true, 
                    data: [], 
                    symbol: optionSymbol,
                    date: dateStr,
                    message: 'No data found - will attempt closest strike'
                };
                this.cache.set(cacheKey, result);
                return result;
            }
            
            // Convert BigQuery format to TradeStation-compatible format
            const bars = rows.map(row => ({
                TimeStamp: this.extractTimestamp(row.TimeStamp),
                Open: row.Open ? row.Open.toString() : '0',
                High: row.High ? row.High.toString() : '0',
                Low: row.Low ? row.Low.toString() : '0',
                Close: row.Close ? row.Close.toString() : '0',
                Volume: row.Volume || 0,
                OptionSymbol: row.OptionSymbol
            }));
            
            const result = {
                success: true,
                data: { Bars: bars },
                symbol: optionSymbol,
                date: dateStr,
                barCount: bars.length,
                dataSource: 'BigQuery'
            };
            
            this.cache.set(cacheKey, result);
            console.log(`✅ Retrieved ${bars.length} option bars for ${optionSymbol} from BigQuery`);
            
            return result;
            
        } catch (error) {
            console.error(`❌ Failed to get option data for ${optionSymbol}:`, error);
            const result = { 
                success: false, 
                error: error.message, 
                symbol: optionSymbol,
                date: dateStr 
            };
            this.cache.set(cacheKey, result);
            return result;
        }
    }
    
    /**
     * Find closest available strike and get its data
     * @param {number} targetStrike - Target strike price
     * @param {Date} date - Trading date
     * @returns {Object} Closest strike data
     */
    async getClosestStrikeData(targetStrike, date) {
        const availableStrikes = await this.getAvailableStrikes(date);
        
        if (availableStrikes.length === 0) {
            console.log(`❌ No strikes available for ${this.formatDate(date)}`);
            return { success: false, error: 'No strikes available' };
        }
        
        // Find closest strike
        let closestStrike = availableStrikes[0];
        let smallestDiff = Math.abs(targetStrike - closestStrike);
        
        for (const strike of availableStrikes) {
            const diff = Math.abs(targetStrike - strike);
            if (diff < smallestDiff) {
                smallestDiff = diff;
                closestStrike = strike;
            }
        }
        
        console.log(`🎯 Using closest strike ${closestStrike} for target ${targetStrike} (${smallestDiff} point difference)`);
        
        // Construct option symbol for closest strike
        const dateStr = this.formatDateForOption(date);
        const closestSymbol = `SPXW ${dateStr}C${closestStrike}`;
        
        const result = await this.getOptionData(closestSymbol, date);
        if (result.success) {
            result.isClosestStrike = true;
            result.targetStrike = targetStrike;
            result.actualStrike = closestStrike;
            result.strikeDifference = smallestDiff;
            
            // Mark trades table that this trade used simulated strike data
            result.simulatedStrike = true;
        }
        
        return result;
    }
    
    /**
     * Format date for BigQuery queries (YYYY-MM-DD)
     * @param {Date} date - Date to format
     * @returns {string} Formatted date
     */
    formatDate(date) {
        return date.toISOString().split('T')[0];
    }
    
    /**
     * Format date for option symbols (YYMMDD)
     * @param {Date} date - Date to format
     * @returns {string} Formatted date for option symbols
     */
    formatDateForOption(date) {
        const year = String(date.getFullYear()).slice(-2);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return `${year}${month}${day}`;
    }
    
    /**
     * Get data quality statistics for a date
     * @param {Date} date - Trading date
     * @returns {Object} Data quality stats
     */
    async getDataQualityStats(date) {
        const dateStr = this.formatDate(date);
        
        const query = `
            SELECT 
                COUNT(*) as total_records,
                COUNT(DISTINCT Strike) as unique_strikes,
                MIN(Strike) as min_strike,
                MAX(Strike) as max_strike,
                COUNT(DISTINCT TimeStamp) as unique_timestamps,
                COUNT(DISTINCT OptionSymbol) as unique_symbols
            FROM \`${this.projectId}.${this.dataset}.${this.table}\`
            WHERE CreatedDate = @date
        `;
        
        try {
            const [rows] = await this.bigquery.query({
                query,
                params: { date: dateStr }
            });
            
            const stats = rows[0] || {
                total_records: 0,
                unique_strikes: 0,
                min_strike: null,
                max_strike: null,
                unique_timestamps: 0,
                unique_symbols: 0
            };
            
            console.log(`📊 Data quality for ${dateStr}: ${stats.total_records} records, ${stats.unique_strikes} strikes (${stats.min_strike}-${stats.max_strike}), ${stats.unique_timestamps} timestamps`);
            return stats;
            
        } catch (error) {
            console.error(`❌ Failed to get data quality stats for ${dateStr}:`, error);
            return null;
        }
    }
    
    /**
     * Test connection and data availability
     * @param {Date} testDate - Date to test (defaults to Aug 4, 2025)
     */
    async testConnection(testDate = new Date('2025-08-04')) {
        console.log('🔍 Testing BigQuery connection and data availability...');
        
        try {
            const stats = await this.getDataQualityStats(testDate);
            if (stats && stats.total_records > 0) {
                console.log(`✅ Connection successful! Found ${stats.total_records} records for ${this.formatDate(testDate)}`);
                return true;
            } else {
                console.log(`⚠️ Connection successful but no data found for ${this.formatDate(testDate)}`);
                return false;
            }
        } catch (error) {
            console.error('❌ Connection test failed:', error);
            return false;
        }
    }
    
    /**
     * Extract timestamp string from BigQuery timestamp object
     * @param {Object|string} timestamp - BigQuery timestamp (object with .value property or string)
     * @returns {string} ISO timestamp string
     */
    extractTimestamp(timestamp) {
        // Handle BigQuery timestamp objects that have a .value property
        if (timestamp && typeof timestamp === 'object' && timestamp.value) {
            return timestamp.value;
        }
        
        // Handle already converted strings
        if (typeof timestamp === 'string') {
            return timestamp;
        }
        
        // Fallback - try to convert to string
        return String(timestamp);
    }
    
    /**
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
        console.log('🗑️ Option data cache cleared');
    }
}

module.exports = { BigQueryOptionDataClient };