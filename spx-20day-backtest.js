// SPX 20-Day Backtesting Engine
// Fetches real market data for SPX and options to validate trading strategy

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { BigQueryOptionDataClient } = require('./bigquery-option-data-client');
require('dotenv').config(); // Load environment variables

// Configuration
const API_BASE = 'https://sim-api.tradestation.com/v3/marketdata/barcharts';
const TRADING_HOURS = {
    start: '13:30:00Z', // 9:30 AM ET in UTC
    end: '21:00:00Z'    // 5:00 PM ET in UTC
};

// Utility Functions
class TimezoneUtils {
    /**
     * Check if timestamp is within trading hours (9:30 AM - 4:00 PM ET)
     * @param {string} timestamp - Bar timestamp to check
     * @returns {boolean} True if within trading hours
     */
    static isWithinTradingHours(timestamp) {
        const date = new Date(timestamp);
        
        // Convert to Eastern Time (handles both EST and EDT automatically)
        const easternTime = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(date);
        
        const hours = parseInt(easternTime.find(part => part.type === 'hour').value);
        const minutes = parseInt(easternTime.find(part => part.type === 'minute').value);
        
        // Convert to minutes since midnight Eastern
        const timeInMinutes = hours * 60 + minutes;
        
        // 9:30 AM ET = 570 minutes, 4:00 PM ET = 960 minutes
        return timeInMinutes >= 570 && timeInMinutes <= 960;
    }
    
    /**
     * Check if timestamp is within entry hours (9:30 AM - 3:30 PM ET)
     * No new entries allowed after 3:30 PM since options expire at 4:00 PM
     * @param {string} timestamp - UTC timestamp
     * @returns {boolean} True if within entry hours
     */
    static isWithinEntryHours(timestamp) {
        const date = new Date(timestamp);
        
        // Convert to Eastern Time (handles both EST and EDT automatically)
        const easternTime = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(date);
        
        const hours = parseInt(easternTime.find(part => part.type === 'hour').value);
        const minutes = parseInt(easternTime.find(part => part.type === 'minute').value);
        
        // Convert to minutes since midnight Eastern
        const timeInMinutes = hours * 60 + minutes;
        
        // 9:30 AM ET = 570 minutes, 3:30 PM ET = 930 minutes
        return timeInMinutes >= 570 && timeInMinutes <= 930;
    }
    
    /**
     * Convert timestamp to Eastern Time string
     * @param {string} timestamp - UTC timestamp
     * @returns {string} Time in HH:MM:SS EST/EDT format
     */
    static toEasternTimeString(timestamp) {
        const date = new Date(timestamp);
        
        const easternTime = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).format(date);
        
        // Determine if we're in EST or EDT
        const january = new Date(date.getFullYear(), 0, 1);
        const july = new Date(date.getFullYear(), 6, 1);
        const stdTimezoneOffset = Math.max(january.getTimezoneOffset(), july.getTimezoneOffset());
        const isDST = date.getTimezoneOffset() < stdTimezoneOffset;
        
        return `${easternTime} ${isDST ? 'EDT' : 'EST'}`;
    }
}

class TradingDateUtils {
    /**
     * Get the last N trading days (excludes weekends)
     * @param {number} days - Number of trading days to get
     * @returns {Date[]} Array of trading dates
     */
    static getLastTradingDays(days = 20) {
        const tradingDays = [];
        const currentDate = new Date();
        
        // Start from yesterday to avoid today's incomplete data
        currentDate.setDate(currentDate.getDate() - 1);
        
        while (tradingDays.length < days) {
            const dayOfWeek = currentDate.getDay();
            
            // Skip weekends (0 = Sunday, 6 = Saturday)
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                tradingDays.push(new Date(currentDate));
            }
            
            currentDate.setDate(currentDate.getDate() - 1);
        }
        
        return tradingDays.reverse(); // Return in chronological order
    }
    
    /**
     * Format date for API calls (YYYY-MM-DDTHH:mm:ssZ)
     * @param {Date} date - Date to format
     * @param {string} time - Time in HH:mm:ssZ format
     * @returns {string} Formatted datetime string
     */
    static formatForAPI(date, time) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}T${time}`;
    }
    
    /**
     * Format date for option symbol (YYMMDD)
     * @param {Date} date - Date to format
     * @returns {string} Formatted date string for options
     */
    static formatForOption(date) {
        const year = String(date.getFullYear()).slice(-2);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return `${year}${month}${day}`;
    }
}

// API Client for TradeStation Data
class TradeStationDataClient {
    constructor() {
        this.baseURL = API_BASE;
        this.requestCount = 0;
        this.maxRequests = 100; // Rate limiting
        this.authToken = null;
        this.optionDataCache = new Map(); // Cache to avoid duplicate calls
        this.clientId = process.env.TRADESTATION_CLIENT_ID;
        this.clientSecret = process.env.TRADESTATION_CLIENT_SECRET;
        this.redirectUri = process.env.TRADESTATION_REDIRECT_URI || 'http://localhost:3000/callback';
        this.baseApiUrl = process.env.TRADESTATION_BASE_URL || 'https://sim-api.tradestation.com/v3';
        this.authUrl = process.env.TRADESTATION_AUTH_URL || 'https://signin.tradestation.com'; // Auth endpoint
        
        // Validate credentials
        if (!this.clientId || !this.clientSecret) {
            console.error('❌ Missing TradeStation credentials!');
            console.log('Please set the following environment variables:');
            console.log('  TRADESTATION_CLIENT_ID=your_client_id');
            console.log('  TRADESTATION_CLIENT_SECRET=your_client_secret');
            console.log('  TRADESTATION_REDIRECT_URI=your_redirect_uri (optional)');
            process.exit(1);
        }
    }
    
    /**
     * Use refresh token to get access token
     * @param {string} refreshToken - Refresh token from TradeStation
     * @returns {Promise<boolean>} Success status
     */
    async authenticateWithRefreshToken(refreshToken) {
        try {
            console.log('🔄 Authenticating with refresh token...');
            
            const response = await axios.post(`${this.authUrl}/oauth/token`, {
                grant_type: 'refresh_token',
                client_id: this.clientId,
                client_secret: this.clientSecret,
                refresh_token: refreshToken
            });
            
            this.authToken = response.data;
            console.log('✅ Successfully authenticated with refresh token');
            console.log(`   Access token expires in: ${response.data.expires_in} seconds`);
            return true;
        } catch (error) {
            console.error('❌ Refresh token authentication failed:', error.response?.data || error.message);
            return false;
        }
    }
    
    /**
     * Check if we have a valid authentication token
     * @returns {boolean} True if authenticated
     */
    isAuthenticated() {
        return this.authToken !== null;
    }
    
    /**
     * Get authorization headers for API requests
     * @returns {Object} Headers object
     */
    getHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };
        
        if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken.access_token}`;
        }
        
        return headers;
    }
    
    /**
     * Fetch SPX minute data for a specific trading day
     * @param {Date} date - Trading date
     * @returns {Promise<Object>} SPX bars data
     */
    async fetchSPXData(date) {
        const firstDate = TradingDateUtils.formatForAPI(date, TRADING_HOURS.start);
        const lastDate = TradingDateUtils.formatForAPI(date, TRADING_HOURS.end);
        
        const url = `${this.baseURL}/$SPXW.X?unit=minute&firstdate=${firstDate}&lastdate=${lastDate}`;
        
        try {
            console.log(`📊 Fetching SPX data for ${date.toDateString()}...`);
            
            if (!this.isAuthenticated()) {
                throw new Error('Not authenticated. Please run authentication first.');
            }
            
            const response = await axios.get(url, { headers: this.getHeaders() });
            this.requestCount++;
            
            return {
                success: true,
                data: response.data,
                date: date,
                url: url
            };
        } catch (error) {
            console.error(`❌ Failed to fetch SPX data for ${date.toDateString()}:`, error.message);
            return {
                success: false,
                error: error.message,
                date: date,
                url: url
            };
        }
    }
    
    /**
     * Fetch option data for a specific strike and date
     * @param {string} optionSymbol - Option symbol (e.g., "SPXW 250729C6395")
     * @param {Date} date - Trading date
     * @returns {Promise<Object>} Option bars data
     */
    async fetchOptionData(optionSymbol, date) {
        // Create cache key for this specific symbol and date
        const cacheKey = `${optionSymbol}_${date.toISOString().split('T')[0]}`;
        
        // Check cache first to avoid duplicate calls
        if (this.optionDataCache.has(cacheKey)) {
            console.log(`📋 Using cached data for ${optionSymbol} (avoiding duplicate call)`);
            return this.optionDataCache.get(cacheKey);
        }
        
        // For options, we need the full trading day range for July 29
        // But ensure both dates are for the same day (July 29)
        const firstDate = TradingDateUtils.formatForAPI(date, TRADING_HOURS.start);
        const lastDate = TradingDateUtils.formatForAPI(date, TRADING_HOURS.end);
        
        // Remove spaces from symbol for URL
        const urlSymbol = optionSymbol.replace(/\s+/g, '%20');
        const url = `${this.baseURL}/${urlSymbol}?unit=minute&firstdate=${firstDate}&lastdate=${lastDate}`;
        
        try {
            console.log(`📈 Fetching option data for ${optionSymbol}...`);
            console.log(`   URL: ${url}`);
            console.log(`   Date Range: ${firstDate} to ${lastDate}`);
            
            if (!this.isAuthenticated()) {
                throw new Error('Not authenticated. Please run authentication first.');
            }
            
            const response = await axios.get(url, { headers: this.getHeaders() });
            this.requestCount++;
            
            console.log(`   Response Status: ${response.status}`);
            console.log(`   Response Headers:`, response.headers['content-type']);
            
            // Detailed response analysis
            if (response.data) {
                console.log(`   Response Data Keys:`, Object.keys(response.data));
                
                if (response.data.Bars) {
                    console.log(`   ✅ Found ${response.data.Bars.length} option bars`);
                    if (response.data.Bars.length === 0) {
                        console.log(`   ⚠️  No bars returned for ${optionSymbol}`);
                        console.log(`   This could mean:`);
                        console.log(`     - Option doesn't exist for this date`);
                        console.log(`     - Option expired before this date`);
                        console.log(`     - Strike price is too far out of money`);
                        console.log(`     - Market was closed`);
                    }
                } else if (response.data.Error) {
                    console.log(`   ❌ API Error:`, response.data.Error);
                } else {
                    console.log(`   ⚠️  Unexpected response format:`, JSON.stringify(response.data, null, 2));
                }
            } else {
                console.log(`   ❌ No response data received`);
            }
            
            const result = {
                success: true,
                data: response.data,
                symbol: optionSymbol,
                date: date,
                url: url,
                barCount: response.data?.Bars?.length || 0
            };
            
            // Cache the result to avoid duplicate calls
            this.optionDataCache.set(cacheKey, result);
            
            return result;
        } catch (error) {
            console.error(`❌ Failed to fetch option data for ${optionSymbol}:`);
            console.error(`   Error Type: ${error.constructor.name}`);
            console.error(`   Status Code: ${error.response?.status}`);
            console.error(`   Status Text: ${error.response?.statusText}`);
            console.error(`   Error Message: ${error.message}`);
            
            if (error.response?.data) {
                console.error(`   API Response:`, error.response.data);
            }
            
            if (error.response?.status === 404) {
                console.error(`   💡 This likely means the option symbol doesn't exist or is invalid`);
            } else if (error.response?.status === 401) {
                console.error(`   💡 Authentication issue - token may have expired`);
            } else if (error.response?.status === 429) {
                console.error(`   💡 Rate limit exceeded - too many requests`);
            }
            
            const result = {
                success: false,
                error: error.message,
                errorDetails: {
                    status: error.response?.status,
                    statusText: error.response?.statusText,
                    data: error.response?.data
                },
                symbol: optionSymbol,
                date: date,
                url: url
            };
            
            // Cache the error result too to avoid retrying the same failed call
            this.optionDataCache.set(cacheKey, result);
            
            return result;
        }
    }
    
    /**
     * Add delay between requests to respect rate limits
     * @param {number} ms - Milliseconds to wait
     */
    async delay(ms = 100) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Clear the option data cache
     */
    clearCache() {
        this.optionDataCache.clear();
        console.log('🗑️ Option data cache cleared');
    }
    
    /**
     * Get cache statistics
     * @returns {Object} Cache stats
     */
    getCacheStats() {
        const cacheEntries = Array.from(this.optionDataCache.entries());
        const successful = cacheEntries.filter(([key, value]) => value.success).length;
        const failed = cacheEntries.filter(([key, value]) => !value.success).length;
        
        return {
            totalEntries: this.optionDataCache.size,
            successful,
            failed,
            hitRate: this.optionDataCache.size > 0 ? (successful / this.optionDataCache.size * 100).toFixed(1) : 0
        };
    }
}

// MACD Study Implementation
class MACDStudy {
    constructor(fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        this.fastPeriod = fastPeriod;
        this.slowPeriod = slowPeriod;
        this.signalPeriod = signalPeriod;
        this.prices = [];
        this.fastEMA = null;
        this.slowEMA = null;
        this.signalEMA = null;
        this.currentMACD = 0;
        this.currentSignal = 0;
        this.currentHistogram = 0;
        this.previousHistogram = 0;
        this.previousMACD = 0;
        this.previousSignal = 0;
    }

    calculateEMA(price, previousEMA, period) {
        if (previousEMA === null) {
            return price;
        }
        const multiplier = 2 / (period + 1);
        return (price * multiplier) + (previousEMA * (1 - multiplier));
    }

    addBar(barData) {
        const price = parseFloat(barData.Close);
        this.prices.push(price);
        
        this.fastEMA = this.calculateEMA(price, this.fastEMA, this.fastPeriod);
        this.slowEMA = this.calculateEMA(price, this.slowEMA, this.slowPeriod);
        
        if (this.prices.length >= this.slowPeriod) {
            this.previousMACD = this.currentMACD;
            this.previousSignal = this.currentSignal;
            this.previousHistogram = this.currentHistogram;
            
            this.currentMACD = this.fastEMA - this.slowEMA;
            this.signalEMA = this.calculateEMA(this.currentMACD, this.signalEMA, this.signalPeriod);
            this.currentSignal = this.signalEMA;
            this.currentHistogram = this.currentMACD - this.currentSignal;
        }
    }

    getCurrentValues() {
        if (this.prices.length < this.slowPeriod) return null;
        
        let crossover = 'none';
        if (this.prices.length > this.slowPeriod + this.signalPeriod) {
            if (this.previousMACD <= this.previousSignal && this.currentMACD > this.currentSignal) {
                crossover = 'bullish';
            } else if (this.previousMACD >= this.previousSignal && this.currentMACD < this.currentSignal) {
                crossover = 'bearish';
            }
        }
        
        return {
            macd: this.currentMACD,
            signal: this.currentSignal,
            histogram: this.currentHistogram,
            crossover: crossover
        };
    }

    reset() {
        this.prices = [];
        this.fastEMA = null;
        this.slowEMA = null;
        this.signalEMA = null;
        this.currentMACD = 0;
        this.currentSignal = 0;
        this.currentHistogram = 0;
        this.previousHistogram = 0;
        this.previousMACD = 0;
        this.previousSignal = 0;
    }
}

// Trading Strategy Engine
class SPXBacktestStrategy {
    constructor() {
        this.macdStudy = new MACDStudy();
        this.currentPosition = null;
        this.previousHistogram = 0;
        this.histogramHistory = []; // Track last 4 histogram values for 4-bar trend analysis
        this.macdHistory = []; // Track last 4 MACD values to check threshold condition before crossover
        this.entrySignals = [];
        this.exitSignals = [];
        this.macdThreshold = -1.0; // Updated from -2.0 to -1.0
        this.profitTarget = 1.0; // $1 profit target
    }

    /**
     * Check if histogram is increasing (becoming more bullish) over the last 4 bars including current crossover bar
     * This indicates momentum building up through the bullish crossover signal
     * @param {number} currentHistogram - Current bar's histogram value (not yet added to history)
     * @returns {boolean} True if histogram shows increasing trend (more bullish values)
     */
    isHistogramIncreasing(currentHistogram) {
        // Need at least 3 previous histogram values + current = 4 total
        if (this.histogramHistory.length < 3) {
            return false;
        }
        
        // Create array of last 3 previous values + current value (which is NOT yet in history)
        const last4Values = [...this.histogramHistory.slice(-3), currentHistogram];
        
        // Check if each value is greater than the previous (increasing/becoming more bullish)
        for (let i = 1; i < last4Values.length; i++) {
            if (last4Values[i] <= last4Values[i-1]) {
                return false;
            }
        }
        
        return true;
    }

    /**
     * Check if MACD was below threshold in recent bars (including current)
     * This handles cases where MACD rises above threshold right at crossover moment
     * @param {number} currentMacd - Current bar's MACD value (not yet added to history)
     * @returns {boolean} True if MACD was below threshold in last 3 bars or current
     */
    wasMacdBelowThreshold(currentMacd) {
        // Check current MACD first
        if (currentMacd <= this.macdThreshold) {
            return true;
        }
        
        // Check if any of the last 3 MACD values were below threshold
        if (this.macdHistory.length === 0) {
            return false;
        }
        
        // Look at last 3 bars (or as many as we have)
        const recentMacds = this.macdHistory.slice(-3);
        return recentMacds.some(macd => macd <= this.macdThreshold);
    }

    /**
     * Process a single bar and generate signals
     * @param {Object} bar - Price bar data
     * @param {Map} optionDataMap - Map of option symbol -> bars for this day
     * @returns {Object[]} Array of signals generated
     */
    processBar(bar, optionDataMap = new Map()) {
        this.macdStudy.addBar(bar);
        const macdValues = this.macdStudy.getCurrentValues();
        
        if (!macdValues) return [];
        
        // Update histogram history (keep last 4 values for 4-bar trend analysis)
        this.histogramHistory.push(macdValues.histogram);
        if (this.histogramHistory.length > 4) {
            this.histogramHistory.shift();
        }
        
        const signals = [];
        
        // Entry Logic: MACD ≤ -1, bullish crossover, histogram increasing over last 4 bars including current (no entries after 3:30 PM ET)
        if (!this.currentPosition && 
            macdValues.macd <= this.macdThreshold && 
            macdValues.crossover === 'bullish' &&
            this.isHistogramIncreasing(macdValues.histogram) &&
            TimezoneUtils.isWithinEntryHours(bar.TimeStamp)) {
            
            const optionSymbol = this.constructOptionSymbol(bar);
            const optionData = optionDataMap.get(optionSymbol) || [];
            const entryTimeET = TimezoneUtils.toEasternTimeString(bar.TimeStamp);
            console.log(`📈 ENTRY: Getting option price for ${optionSymbol} at ${entryTimeET} with ${optionData.length} option bars`);
            const last4Values = [...this.histogramHistory.slice(-3), macdValues.histogram];
            console.log(`   📊 Histogram 4-bar trend (including current): [${last4Values.map(h => h.toFixed(4)).join(' → ')}]`);
            console.log(`   📊 Current Bar: Histogram=${macdValues.histogram.toFixed(4)}, MACD=${macdValues.macd.toFixed(4)}, Signal=${macdValues.signal.toFixed(4)}`);
            const optionPrice = this.getOptionPrice(optionSymbol, bar.TimeStamp, optionData);
            
            const signal = {
                type: 'ENTRY',
                symbol: optionSymbol,
                spxPrice: parseFloat(bar.Close),
                optionPrice: optionPrice,
                timestamp: bar.TimeStamp,
                reason: `MACD bullish crossover with MACD ≤ ${this.macdThreshold} and histogram increasing over last 4 bars including crossover`,
                macd: macdValues.macd,
                signal: macdValues.signal,
                histogram: macdValues.histogram
            };
            
            this.entrySignals.push(signal);
            signals.push(signal);
            
            this.currentPosition = {
                symbol: optionSymbol,
                entryPrice: optionPrice,
                entryTime: bar.TimeStamp,
                spxEntryPrice: parseFloat(bar.Close),
                initialHistogram: macdValues.histogram
            };
        }
        
        // Exit Logic: $1 profit AND momentum shrinking
        if (this.currentPosition) {
            const optionData = optionDataMap.get(this.currentPosition.symbol) || [];
            const currentOptionPrice = this.getOptionPrice(this.currentPosition.symbol, bar.TimeStamp, optionData);
            const dollarProfit = (currentOptionPrice - this.currentPosition.entryPrice) * 100; // Option multiplier (dollar P&L)
            const percentProfit = ((currentOptionPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100; // Percentage P&L
            const momentumShrinking = macdValues.histogram < this.previousHistogram;
            
            // Check for negative crossover (bearish signal) - PRIORITY EXIT
            const negativeCrossover = macdValues.crossover === 'bearish';
            
            // Check for stop loss (20% loss)
            const lossThreshold = -20.0; // 20% stop loss
            const stopLossTriggered = percentProfit <= lossThreshold;
            
            // Check for profit target with momentum shrinking
            const profitTargetMet = dollarProfit >= this.profitTarget && momentumShrinking;
            
            if (negativeCrossover || stopLossTriggered || profitTargetMet) {
                let exitReason;
                if (negativeCrossover) {
                    exitReason = 'Negative crossover signal (bearish MACD crossover)';
                } else if (stopLossTriggered) {
                    exitReason = 'Stop loss triggered (20% loss)';
                } else {
                    exitReason = 'Profit target reached AND momentum shrinking';
                }
                
                const signal = {
                    type: 'EXIT',
                    symbol: this.currentPosition.symbol,
                    spxPrice: parseFloat(bar.Close),
                    optionPrice: currentOptionPrice,
                    timestamp: bar.TimeStamp,
                    profit: dollarProfit,
                    reason: exitReason,
                    macd: macdValues.macd,
                    signal: macdValues.signal,
                    histogram: macdValues.histogram
                };
                
                this.exitSignals.push(signal);
                signals.push(signal);
                
                this.currentPosition = null;
            }
        }
        
        this.previousHistogram = macdValues.histogram;
        return signals;
    }

    /**
     * Construct option symbol based on SPX price and date
     * @param {Object} bar - Price bar data
     * @returns {string} Option symbol
     */
    constructOptionSymbol(bar) {
        const spxPrice = parseFloat(bar.Close);
        const strike = Math.floor(spxPrice / 5) * 5; // Round to nearest $5
        
        // Use the same date as the analysis (not next Friday)
        const date = new Date(bar.TimeStamp);
        const dateStr = TradingDateUtils.formatForOption(date);
        
        return `SPXW ${dateStr}C${strike}`;
    }

    /**
     * Get option price from option data or estimate if not available
     * @param {string} optionSymbol - Option symbol
     * @param {string} timestamp - Bar timestamp
     * @param {Object[]} optionData - Array of option data
     * @returns {number} Option price
     */
    getOptionPrice(optionSymbol, timestamp, optionData) {
        // DEBUG: Add stack trace to see where this is being called from
        const stack = new Error().stack;
        const caller = stack.split('\n')[2]?.trim() || 'unknown';
        
        // Debug: Log what we're trying to match
        if (optionData.length === 0) {
            console.warn(`⚠️  No option data provided for ${optionSymbol}, using estimate`);
            console.warn(`   Called from: ${caller}`);
            console.warn(`   Timestamp: ${timestamp}`);
            return 1.0;
        }
        
        console.log(`🔍 getOptionPrice called for ${optionSymbol} at ${timestamp} with ${optionData.length} bars`);
        console.log(`   Called from: ${caller}`);
        
        const targetTime = new Date(timestamp).getTime();
        
        // DEBUG: Show first few option data timestamps to verify they're parsed correctly
        if (optionData.length > 0) {
            console.log(`   📊 First few option timestamps:`);
            optionData.slice(0, 3).forEach((bar, i) => {
                const barTime = new Date(bar.TimeStamp).getTime();
                const diffMs = Math.abs(barTime - targetTime);
                const diffMin = Math.round(diffMs / 60000);
                console.log(`      ${i+1}. ${bar.TimeStamp} (${diffMin}min diff) - $${bar.Close}`);
            });
        }
        
        // Try different matching strategies in order of preference
        
        // Strategy 1: Exact timestamp match (within 1 minute)  
        for (const optionBar of optionData) {
            const barTime = new Date(optionBar.TimeStamp).getTime();
            const diffMs = Math.abs(barTime - targetTime);
            if (diffMs < 60000) { // Within 1 minute
                console.log(`✅ Found exact match for ${optionSymbol} at ${optionBar.TimeStamp}: $${optionBar.Close} (${Math.round(diffMs/1000)}s diff)`);
                return parseFloat(optionBar.Close);
            }
        }
        
        // Strategy 2: Close timestamp match (within 3 minutes) 
        for (const optionBar of optionData) {
            const barTime = new Date(optionBar.TimeStamp).getTime();
            const diffMs = Math.abs(barTime - targetTime);
            if (diffMs < 180000) { // Within 3 minutes
                console.log(`✅ Found close match for ${optionSymbol} at ${optionBar.TimeStamp}: $${optionBar.Close} (${Math.round(diffMs/60000)}min diff)`);
                return parseFloat(optionBar.Close);
            }
        }
        
        // Strategy 3: Find closest timestamp
        let closestBar = null;
        let smallestDiff = Infinity;
        
        for (const optionBar of optionData) {
            const barTime = new Date(optionBar.TimeStamp).getTime();
            const diff = Math.abs(barTime - targetTime);
            
            if (diff < smallestDiff) {
                smallestDiff = diff;
                closestBar = optionBar;
            }
        }
        
        if (closestBar) {
            const diffMinutes = Math.round(smallestDiff / 60000);
            console.log(`📍 Using closest match for ${optionSymbol}: ${closestBar.TimeStamp} (${diffMinutes}min diff): $${closestBar.Close}`);
            return parseFloat(closestBar.Close);
        }
        
        // Strategy 4: Use last available price
        const lastBar = optionData[optionData.length - 1];
        console.log(`📊 Using last available price for ${optionSymbol}: $${lastBar.Close}`);
        return parseFloat(lastBar.Close);
    }

    /**
     * Reset strategy for new day
     */
    reset() {
        this.macdStudy.reset();
        this.currentPosition = null;
        this.previousHistogram = 0;
    }

    /**
     * Get strategy results
     * @returns {Object} Results summary
     */
    getResults() {
        return {
            entrySignals: this.entrySignals,
            exitSignals: this.exitSignals,
            totalTrades: Math.min(this.entrySignals.length, this.exitSignals.length),
            currentPosition: this.currentPosition
        };
    }
}

// Main Backtesting Engine
class SPX20DayBacktest {
    constructor() {
        this.dataClient = new TradeStationDataClient();
        this.bigqueryClient = new BigQueryOptionDataClient();
        this.strategy = new SPXBacktestStrategy();
        this.results = [];
        this.dailyResults = [];
        this.overallStats = {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalProfit: 0,
            totalLoss: 0,
            netPnL: 0,
            negativeCrossoverExits: 0,
            stopLossExits: 0,
            profitTargetExits: 0,
            bigQueryDays: 0,
            tradestationDays: 0
        };
    }

    /**
     * Authenticate with TradeStation API using refresh token
     */
    async authenticate() {
        console.log('🔐 Enhanced Authentication (TradeStation + BigQuery)');
        console.log('='.repeat(60));
        
        // Test BigQuery connection first
        console.log('🔍 Testing BigQuery connection...');
        const bqConnected = await this.bigqueryClient.testConnection();
        if (!bqConnected) {
            console.log('⚠️ BigQuery connection failed - will use TradeStation only for options');
        } else {
            console.log('✅ BigQuery connection successful - expired options data available');
        }
        
        // Check for refresh token from command line or environment
        const refreshToken = process.argv.find(arg => arg.startsWith('--refresh-token='))?.split('=')[1] ||
                            process.env.TRADESTATION_REFRESH_TOKEN;
        
        if (refreshToken) {
            console.log('🎯 Using refresh token authentication...');
            const success = await this.dataClient.authenticateWithRefreshToken(refreshToken);
            
            if (success) {
                // Store the new credentials with timestamp
                const credentialsPath = path.join(__dirname, '.ts_credentials.json');
                this.dataClient.authToken.timestamp = Date.now();
                fs.writeFileSync(credentialsPath, JSON.stringify(this.dataClient.authToken, null, 2));
                console.log('✅ Authentication successful with refresh token');
                return true;
            } else {
                console.log('❌ Refresh token authentication failed');
                return false;
            }
        }
        
        // Check for stored valid credentials
        const credentialsPath = path.join(__dirname, '.ts_credentials.json');
        if (fs.existsSync(credentialsPath)) {
            try {
                const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
                
                // Check if token is still valid (with 5 minute buffer)
                if (credentials.expires_in && credentials.timestamp) {
                    const expiryTime = credentials.timestamp + (credentials.expires_in * 1000);
                    const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
                    
                    if (Date.now() < (expiryTime - bufferTime)) {
                        this.dataClient.authToken = credentials;
                        console.log('✅ Using valid stored authentication credentials');
                        return true;
                    } else {
                        console.log('⚠️  Stored credentials expired, need fresh refresh token');
                    }
                } else {
                    this.dataClient.authToken = credentials;
                    console.log('⚠️  Using stored credentials (no expiry info)');
                    return true;
                }
            } catch (error) {
                console.log('⚠️  Stored credentials invalid, need fresh authentication');
            }
        }
        
        // No authentication method available
        console.log('\n❌ No refresh token provided!');
        console.log('\n🚀 REQUIRED: Provide your TradeStation refresh token');
        console.log('\n📖 Usage Options:');
        console.log('1. Command line:');
        console.log('   node spx-20day-backtest.js --refresh-token=YOUR_REFRESH_TOKEN');
        console.log('\n2. Environment variable:');
        console.log('   TRADESTATION_REFRESH_TOKEN=YOUR_TOKEN node spx-20day-backtest.js');
        console.log('\n3. Add to .env file:');
        console.log('   TRADESTATION_REFRESH_TOKEN=YOUR_REFRESH_TOKEN');
        console.log('\n💡 Get your refresh token from TradeStation API documentation');
        console.log('   https://api.tradestation.com/docs/fundamentals/authentication/refresh-tokens');
        
        return false;
    }
    
    /**
     * Run the complete backtest (20 days or single day)
     */
    async runBacktest() {
        // Check for single day mode
        const singleDate = process.argv.find(arg => arg.startsWith('--single-day=') || arg.startsWith('--date='))?.split('=')[1];
        
        if (singleDate) {
            console.log('🎯 Starting SPX Single Day Backtest');
            console.log('='.repeat(50));
            console.log(`Focus Date: ${singleDate}`);
            
            // Authenticate first
            if (!await this.authenticate()) {
                console.log('\n❌ Authentication required to proceed. Exiting...');
                return;
            }
            
            const testDate = new Date(singleDate + 'T16:00:00Z'); // Use 4 PM UTC = 12 PM EST to ensure correct date
            console.log(`\n📊 Processing Single Day: ${testDate.toDateString()}`);
            
            await this.processTradingDay(testDate);
            this.calculateOverallStats();
            this.showCacheStats();
            this.generateReport();
            return;
        }
        
        console.log('🚀 Starting SPX 20-Day Backtest');
        console.log('='.repeat(50));
        
        // Authenticate first
        if (!await this.authenticate()) {
            console.log('\n❌ Authentication required to proceed. Exiting...');
            return;
        }
        
        const tradingDays = TradingDateUtils.getLastTradingDays(20);
        console.log(`\n📅 Testing ${tradingDays.length} trading days from ${tradingDays[0].toDateString()} to ${tradingDays[tradingDays.length-1].toDateString()}`);
        
        for (let i = 0; i < tradingDays.length; i++) {
            const date = tradingDays[i];
            console.log(`\n📊 Processing Day ${i+1}/20: ${date.toDateString()}`);
            
            await this.processTradingDay(date);
            
            // Add delay between days to respect rate limits
            if (i < tradingDays.length - 1) {
                await this.dataClient.delay(500);
            }
        }
        
        this.calculateOverallStats();
        this.showCacheStats();
        this.generateReport();
    }

    /**
     * Process a single trading day
     * @param {Date} date - Trading date to process
     */
    async processTradingDay(date) {
        // Reset strategy for new day
        this.strategy.reset();
        
        // Step 1: Fetch SPX data for the day (always from TradeStation)
        const spxResult = await this.dataClient.fetchSPXData(date);
        if (!spxResult.success) {
            console.error(`❌ Failed to fetch SPX data for ${date.toDateString()}`);
            return;
        }
        
        const spxBars = spxResult.data.Bars || [];
        if (spxBars.length === 0) {
            console.warn(`⚠️  No SPX data available for ${date.toDateString()}`);
            return;
        }
        
        console.log(`   ✅ Loaded ${spxBars.length} SPX bars from TradeStation`);
        
        // Step 1.5: Determine option data source
        const useBigQuery = this.bigqueryClient.isDataAvailableInBigQuery(date);
        console.log(`   📊 Using ${useBigQuery ? 'BigQuery' : 'TradeStation'} for option data`);
        
        if (useBigQuery) {
            this.overallStats.bigQueryDays++;
            // Get BigQuery data quality stats
            const stats = await this.bigqueryClient.getDataQualityStats(date);
            if (stats && stats.total_records > 0) {
                console.log(`   📊 BigQuery: ${stats.unique_strikes} strikes, ${stats.unique_timestamps} timestamps`);
            } else {
                console.log(`   ⚠️ No BigQuery data available for ${date.toDateString()}`);
            }
        } else {
            this.overallStats.tradestationDays++;
        }
        
        // Step 2: Determine potential strikes based on SPX price action (not pre-fetch data)
        let availableStrikes = [];
        
        if (useBigQuery) {
            // Get list of available strikes (metadata only, no option data yet)
            availableStrikes = await this.bigqueryClient.getAvailableStrikes(date);
            console.log(`   🎯 Found ${availableStrikes.length} available strikes in BigQuery`);
        }
        
        // Calculate SPX price range for strike selection
        let minSpx = Infinity;
        let maxSpx = -Infinity;
        
        for (const bar of spxBars) {
            const price = parseFloat(bar.Close);
            minSpx = Math.min(minSpx, price);
            maxSpx = Math.max(maxSpx, price);
        }
        
        const minStrike = Math.floor((minSpx - 20) / 5) * 5;
        const maxStrike = Math.ceil((maxSpx + 20) / 5) * 5;
        
        console.log(`   📊 SPX range: ${minSpx.toFixed(2)} - ${maxSpx.toFixed(2)}, Strike range: ${minStrike} - ${maxStrike}`);
        
        // Step 3: Run strategy with on-demand option data fetching
        this.strategy.reset();
        const dayTrades = [];
        const optionDataCache = new Map(); // Cache for fetched option data
        
        // Create enhanced strategy processor with on-demand fetching
        const fetchOptionDataOnDemand = async (optionSymbol) => {
            if (optionDataCache.has(optionSymbol)) {
                return optionDataCache.get(optionSymbol);
            }
            
            console.log(`   🔄 Fetching option data on-demand for ${optionSymbol}...`);
            
            if (useBigQuery) {
                const optionResult = await this.bigqueryClient.getOptionData(optionSymbol, date);
                
                if (optionResult.success && optionResult.data && optionResult.data.Bars && optionResult.data.Bars.length > 0) {
                    const bars = optionResult.data.Bars;
                    bars.dataSource = 'BigQuery';
                    optionDataCache.set(optionSymbol, bars);
                    console.log(`   ✅ BigQuery: ${bars.length} bars for ${optionSymbol}`);
                    return bars;
                } else {
                    // Try closest strike fallback
                    const strikeMatch = optionSymbol.match(/C(\d+)$/);
                    if (strikeMatch) {
                        const targetStrike = parseInt(strikeMatch[1]);
                        const closestResult = await this.bigqueryClient.getClosestStrikeData(targetStrike, date);
                        if (closestResult.success && closestResult.data && closestResult.data.Bars) {
                            const bars = closestResult.data.Bars;
                            bars.dataSource = 'BigQuery-Closest';
                            bars.simulatedStrike = true;
                            optionDataCache.set(optionSymbol, bars);
                            console.log(`   🎯 BigQuery: Using closest strike for ${optionSymbol} (${bars.length} bars)`);
                            return bars;
                        }
                    }
                }
            } else {
                // TradeStation fallback
                const optionResult = await this.dataClient.fetchOptionData(optionSymbol, date);
                if (optionResult.success && optionResult.data && optionResult.data.Bars) {
                    const bars = optionResult.data.Bars;
                    bars.dataSource = 'TradeStation';
                    optionDataCache.set(optionSymbol, bars);
                    return bars;
                }
            }
            
            // Return empty array if no data found
            optionDataCache.set(optionSymbol, []);
            return [];
        };
        
        console.log(`   🔄 Processing ${spxBars.length} SPX bars and analyzing MACD signals...`);
        
        let entryOpportunities = 0;
        let macdBelowThreshold = 0;
        let bullishCrossovers = 0;
        
        for (const bar of spxBars) {
            this.strategy.macdStudy.addBar(bar);
            const macdValues = this.strategy.macdStudy.getCurrentValues();
            
            if (macdValues) {
                // Debug MACD conditions
                if (macdValues.macd <= this.strategy.macdThreshold) {
                    macdBelowThreshold++;
                }
                if (macdValues.crossover === 'bullish') {
                    bullishCrossovers++;
                    const timeET = TimezoneUtils.toEasternTimeString(bar.TimeStamp);
                    console.log(`   📊 Bullish crossover at ${bar.TimeStamp} (${timeET}): Histogram=${macdValues.histogram.toFixed(4)}, MACD=${macdValues.macd.toFixed(4)}`);
                    
                    // Show histogram history for debugging (BEFORE adding current value to history)
                    if (this.strategy.histogramHistory.length >= 3) {
                        // Create the 4-bar pattern the same way as isHistogramIncreasing function
                        const last4Values = [...this.strategy.histogramHistory.slice(-3), macdValues.histogram];
                        const isIncreasing = this.strategy.isHistogramIncreasing(macdValues.histogram);
                        console.log(`   📈 Histogram 4-bar pattern: [${last4Values.map(h => h.toFixed(4)).join(' → ')}] - ${isIncreasing ? '✅ INCREASING' : '❌ NOT INCREASING'}`);
                        
                        // Debug each entry condition
                        const noPosition = !this.strategy.currentPosition;
                        const macdWasBelowThreshold = this.strategy.wasMacdBelowThreshold(macdValues.macd);
                        const withinEntryHours = TimezoneUtils.isWithinEntryHours(bar.TimeStamp);
                        
                        console.log(`   🔍 Entry conditions: NoPosition=${noPosition}, MACD_WAS≤${this.strategy.macdThreshold}=${macdWasBelowThreshold}, Histogram↑=${isIncreasing}, WithinHours=${withinEntryHours}`);
                        
                        if (noPosition && macdWasBelowThreshold && isIncreasing && withinEntryHours) {
                            console.log(`   🎯 ALL CONDITIONS MET - Should generate entry!`);
                        }
                    } else {
                        console.log(`   ⚠️ Insufficient histogram history: ${this.strategy.histogramHistory.length} values (need 3 previous + current)`);
                    }
                }
                
                // Check entry conditions: MACD was ≤ -1 in recent bars, bullish crossover, histogram increasing over last 4 bars including current
                // IMPORTANT: Call this BEFORE updating histories so current values are not yet in history
                if (!this.strategy.currentPosition && 
                    this.strategy.wasMacdBelowThreshold(macdValues.macd) && 
                    macdValues.crossover === 'bullish' &&
                    this.strategy.isHistogramIncreasing(macdValues.histogram)) {
                    
                    if (!TimezoneUtils.isWithinEntryHours(bar.TimeStamp)) {
                        const timeET = TimezoneUtils.toEasternTimeString(bar.TimeStamp);
                        console.log(`   ⏰ Entry opportunity filtered out - after 3:30 PM ET cutoff: ${timeET}`);
                        continue; // Skip this bar
                    }
                    
                    entryOpportunities++;
                    console.log(`   🎯 ENTRY OPPORTUNITY: MACD=${macdValues.macd.toFixed(3)} at ${bar.TimeStamp}`);
                    // Show the correct 4-bar pattern (3 previous values + current crossover value)
                    const last4Values = [...this.strategy.histogramHistory.slice(-3), macdValues.histogram];
                    console.log(`   📊 Histogram 4-bar trend (3 previous + current crossover): [${last4Values.map(h => h.toFixed(4)).join(' → ')}]`);
                    console.log(`   📊 Current Bar: Histogram=${macdValues.histogram.toFixed(4)}, MACD=${macdValues.macd.toFixed(4)}, Signal=${macdValues.signal.toFixed(4)}`);
                    
                    // Fetch option data only when needed
                    const optionSymbol = this.strategy.constructOptionSymbol(bar);
                    const optionData = await fetchOptionDataOnDemand(optionSymbol);
                    const optionPrice = this.strategy.getOptionPrice(optionSymbol, bar.TimeStamp, optionData);
                    
                    const signal = {
                        type: 'ENTRY',
                        symbol: optionSymbol,
                        spxPrice: parseFloat(bar.Close),
                        optionPrice: optionPrice,
                        timestamp: bar.TimeStamp,
                        reason: `MACD bullish crossover with MACD ≤ ${this.strategy.macdThreshold} and histogram increasing over last 4 bars including crossover`,
                        macd: macdValues.macd,
                        signal: macdValues.signal,
                        histogram: macdValues.histogram,
                        dataSource: optionData.dataSource || 'BigQuery'
                    };
                    
                    console.log(`   📈 ENTRY SIGNAL: ${signal.symbol} at ${signal.timestamp} - Price: $${signal.optionPrice}`);
                    dayTrades.push({ entry: signal, exit: null });
                    
                    this.strategy.currentPosition = {
                        symbol: optionSymbol,
                        entryPrice: optionPrice,
                        entryTime: bar.TimeStamp,
                        spxEntryPrice: parseFloat(bar.Close),
                        initialHistogram: macdValues.histogram
                    };
                }
                
                // Check exit conditions
                if (this.strategy.currentPosition) {
                    const optionSymbol = this.strategy.currentPosition.symbol;
                    let optionData = optionDataCache.get(optionSymbol) || [];
                    if (optionData.length === 0) {
                        optionData = await fetchOptionDataOnDemand(optionSymbol);
                    }
                    
                    const currentOptionPrice = this.strategy.getOptionPrice(optionSymbol, bar.TimeStamp, optionData);
                    const dollarProfit = (currentOptionPrice - this.strategy.currentPosition.entryPrice) * 100;
                    const percentProfit = ((currentOptionPrice - this.strategy.currentPosition.entryPrice) / this.strategy.currentPosition.entryPrice) * 100;
                    const momentumShrinking = macdValues.histogram < this.strategy.previousHistogram;
                    
                    // Check exit conditions
                    const negativeCrossover = macdValues.crossover === 'bearish';
                    const stopLossTriggered = percentProfit <= -20.0;
                    const profitTargetMet = dollarProfit >= this.strategy.profitTarget && momentumShrinking;
                    
                    // DEBUG: Show MACD values when we have a position
                    const timeET = TimezoneUtils.toEasternTimeString(bar.TimeStamp);
                    console.log(`   🔍 Position check at ${timeET}: MACD=${macdValues.macd.toFixed(4)}, Signal=${macdValues.signal.toFixed(4)}, Crossover=${macdValues.crossover}, Profit=${percentProfit.toFixed(2)}%`);
                    
                    // Enhanced debug for critical 12:50-13:00 timeframe (per user chart analysis)
                    const hourET = parseInt(timeET.split(':')[0]);
                    const minuteET = parseInt(timeET.split(':')[1]);
                    if (hourET === 12 && minuteET >= 50 || hourET === 13 && minuteET <= 10) {
                        console.log(`   🎯 CRITICAL TIMEFRAME ${timeET}: MACD=${macdValues.macd.toFixed(4)}, Signal=${macdValues.signal.toFixed(4)}, Hist=${macdValues.histogram.toFixed(4)}, Crossover=${macdValues.crossover}`);
                        
                        // Check if this should be an entry opportunity
                        if (macdValues.crossover === 'bullish') {
                            const macdCondition = this.strategy.wasMacdBelowThreshold(macdValues.macd);
                            const histogramCondition = this.strategy.isHistogramIncreasing(macdValues.histogram);
                            const recentMacds = this.strategy.macdHistory.slice(-3);
                            console.log(`   🔍 DETAILED ENTRY CHECK: MACD_WAS≤${this.strategy.macdThreshold}=${macdCondition}, Histogram↑=${histogramCondition}`);
                            console.log(`   📊 Recent MACD values: [${recentMacds.map(m => m.toFixed(4)).join(' → ')} → ${macdValues.macd.toFixed(4)}] (current)`);
                            
                            if (!macdCondition) {
                                console.log(`   ❌ MISSED ENTRY: Neither current MACD ${macdValues.macd.toFixed(4)} nor recent MACDs were ≤ ${this.strategy.macdThreshold}`);
                            } else {
                                console.log(`   ✅ MACD CONDITION MET: Either current (${macdValues.macd.toFixed(4)}) or recent MACDs were ≤ ${this.strategy.macdThreshold}`);
                            }
                        }
                    }
                    
                    if (macdValues.crossover === 'bearish') {
                        console.log(`   📉 BEARISH CROSSOVER DETECTED at ${timeET}: MACD=${macdValues.macd.toFixed(4)}, Signal=${macdValues.signal.toFixed(4)}`);
                    }
                    
                    if (negativeCrossover || stopLossTriggered || profitTargetMet) {
                        let exitReason;
                        if (negativeCrossover) {
                            exitReason = 'Negative crossover signal (bearish MACD crossover)';
                        } else if (stopLossTriggered) {
                            exitReason = 'Stop loss triggered (20% loss)';
                        } else {
                            exitReason = 'Profit target reached AND momentum shrinking';
                        }
                        
                        const signal = {
                            type: 'EXIT',
                            symbol: optionSymbol,
                            spxPrice: parseFloat(bar.Close),
                            optionPrice: currentOptionPrice,
                            timestamp: bar.TimeStamp,
                            profit: dollarProfit,
                            reason: exitReason,
                            macd: macdValues.macd,
                            signal: macdValues.signal,
                            histogram: macdValues.histogram,
                            dataSource: optionData.dataSource || 'BigQuery'
                        };
                        
                        console.log(`   📉 EXIT SIGNAL: ${signal.symbol} at ${signal.timestamp} - ${signal.reason} - P&L: $${signal.profit.toFixed(2)} (${percentProfit.toFixed(1)}%)`);
                        
                        const lastTrade = dayTrades[dayTrades.length - 1];
                        if (lastTrade && !lastTrade.exit) {
                            lastTrade.exit = signal;
                        }
                        
                        this.strategy.currentPosition = null;
                    }
                }
                
                this.strategy.previousHistogram = macdValues.histogram;
                
                // Enhanced debug for critical 12:50-13:00 timeframe - show all bars
                const timeET = TimezoneUtils.toEasternTimeString(bar.TimeStamp);
                const hourET = parseInt(timeET.split(':')[0]);
                const minuteET = parseInt(timeET.split(':')[1]);
                if (hourET === 12 && minuteET >= 50 || hourET === 13 && minuteET <= 5) {
                    console.log(`   📊 ${timeET}: MACD=${macdValues.macd.toFixed(4)}, Signal=${macdValues.signal.toFixed(4)}, Hist=${macdValues.histogram.toFixed(4)}, Crossover=${macdValues.crossover || 'none'}`);
                }
                
                // Update histories AFTER all processing is complete (keep last 4 values each)
                this.strategy.histogramHistory.push(macdValues.histogram);
                if (this.strategy.histogramHistory.length > 4) {
                    this.strategy.histogramHistory.shift();
                }
                
                this.strategy.macdHistory.push(macdValues.macd);
                if (this.strategy.macdHistory.length > 4) {
                    this.strategy.macdHistory.shift();
                }
            }
        }
        
        console.log(`   📊 MACD Analysis Summary:`);
        console.log(`      Bars with MACD ≤ ${this.strategy.macdThreshold}: ${macdBelowThreshold}/${spxBars.length}`);
        console.log(`      Bullish crossovers: ${bullishCrossovers}`);
        console.log(`      Entry opportunities: ${entryOpportunities}`);
        console.log(`      Option symbols fetched: ${optionDataCache.size}`);
        
        console.log(`   📊 Option Data Cache Summary: ${optionDataCache.size} symbols fetched`);
        
        // Calculate day results
        const dayResults = this.calculateDayResults(date, spxBars.length, dayTrades, useBigQuery);
        this.dailyResults.push(dayResults);
        
        console.log(`   💰 Day P&L: $${dayResults.netPnL.toFixed(2)} (${dayResults.trades.length} trades) [${useBigQuery ? 'BigQuery' : 'TradeStation'}]`);
    }

    /**
     * Calculate results for a single day
     * @param {Date} date - Trading date
     * @param {number} barCount - Number of SPX bars processed
     * @param {Object[]} trades - Array of trades for the day
     * @returns {Object} Day results summary
     */
    calculateDayResults(date, barCount, trades, usedBigQuery = false) {
        let netPnL = 0;
        const completedTrades = trades.filter(t => t.entry && t.exit);
        
        for (const trade of completedTrades) {
            const pnl = trade.exit.profit;
            netPnL += pnl;
        }
        
        return {
            date: date,
            spxBars: barCount,
            entrySignals: trades.length,
            exitSignals: completedTrades.length,
            trades: completedTrades,
            netPnL: netPnL,
            dataSource: usedBigQuery ? 'BigQuery' : 'TradeStation',
            message: `${completedTrades.length} completed trades`
        };
    }

    /**
     * Show cache statistics
     */
    showCacheStats() {
        console.log('\n📊 Option Data Cache Statistics:');
        console.log('='.repeat(40));
        
        const stats = this.dataClient.getCacheStats();
        console.log(`Total Cache Entries: ${stats.totalEntries}`);
        console.log(`Successful Calls: ${stats.successful}`);
        console.log(`Failed Calls: ${stats.failed}`);
        console.log(`Success Rate: ${stats.hitRate}%`);
        console.log(`API Requests Made: ${this.dataClient.requestCount}`);
        console.log(`Duplicate Calls Avoided: ${stats.totalEntries > 0 ? 'Yes' : 'No'}`);
    }
    
    /**
     * Calculate overall statistics across all days
     */
    calculateOverallStats() {
        let totalProfit = 0;
        let totalLoss = 0;
        let winningTrades = 0;
        let losingTrades = 0;
        let totalTrades = 0;
        let negativeCrossoverExits = 0;
        let stopLossExits = 0;
        let profitTargetExits = 0;
        
        for (const dayResult of this.dailyResults) {
            for (const trade of dayResult.trades) {
                totalTrades++;
                const pnl = trade.exit.profit;
                
                if (pnl > 0) {
                    totalProfit += pnl;
                    winningTrades++;
                } else {
                    totalLoss += Math.abs(pnl);
                    losingTrades++;
                }
                
                // Count exit reasons
                if (trade.exit.reason.includes('Negative crossover')) {
                    negativeCrossoverExits++;
                } else if (trade.exit.reason.includes('Stop loss')) {
                    stopLossExits++;
                } else {
                    profitTargetExits++;
                }
            }
        }
        
        this.overallStats = {
            totalTrades,
            winningTrades,
            losingTrades,
            totalProfit,
            totalLoss,
            netPnL: totalProfit - totalLoss,
            winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
            avgWin: winningTrades > 0 ? totalProfit / winningTrades : 0,
            avgLoss: losingTrades > 0 ? totalLoss / losingTrades : 0,
            negativeCrossoverExits,
            stopLossExits,
            profitTargetExits,
            bigQueryDays: this.overallStats.bigQueryDays,
            tradestationDays: this.overallStats.tradestationDays
        };
    }

    /**
     * Generate comprehensive backtest report
     */
    generateReport() {
        const reportLines = [];
        reportLines.push('ENHANCED SPX 20-DAY BACKTEST REPORT');
        reportLines.push('='.repeat(60));
        reportLines.push(`Generated: ${new Date().toLocaleString()}`);
        reportLines.push(`TradeStation API Requests: ${this.dataClient.requestCount}`);
        reportLines.push('');
        
        // Overall Summary
        reportLines.push('OVERALL SUMMARY');
        reportLines.push('-'.repeat(30));
        reportLines.push(`Total Trading Days: ${this.dailyResults.length}`);
        reportLines.push(`Total Trades: ${this.overallStats.totalTrades}`);
        reportLines.push(`Winning Trades: ${this.overallStats.winningTrades}`);
        reportLines.push(`Losing Trades: ${this.overallStats.losingTrades}`);
        reportLines.push(`Win Rate: ${this.overallStats.winRate.toFixed(1)}%`);
        reportLines.push(`Total Profit: $${this.overallStats.totalProfit.toFixed(2)}`);
        reportLines.push(`Total Loss: $${this.overallStats.totalLoss.toFixed(2)}`);
        reportLines.push(`Net P&L: $${this.overallStats.netPnL.toFixed(2)}`);
        reportLines.push(`Average Win: $${this.overallStats.avgWin.toFixed(2)}`);
        reportLines.push(`Average Loss: $${this.overallStats.avgLoss.toFixed(2)}`);
        reportLines.push('');
        
        // Exit Reason Analysis (NEW)
        reportLines.push('EXIT REASON BREAKDOWN');
        reportLines.push('-'.repeat(30));
        reportLines.push(`Negative Crossover Exits: ${this.overallStats.negativeCrossoverExits} (${(this.overallStats.negativeCrossoverExits/Math.max(this.overallStats.totalTrades,1)*100).toFixed(1)}%)`);
        reportLines.push(`Stop Loss Exits: ${this.overallStats.stopLossExits} (${(this.overallStats.stopLossExits/Math.max(this.overallStats.totalTrades,1)*100).toFixed(1)}%)`);
        reportLines.push(`Profit Target Exits: ${this.overallStats.profitTargetExits} (${(this.overallStats.profitTargetExits/Math.max(this.overallStats.totalTrades,1)*100).toFixed(1)}%)`);
        reportLines.push('');
        
        // Data Source Summary (NEW)
        reportLines.push('DATA SOURCE SUMMARY');
        reportLines.push('-'.repeat(30));
        reportLines.push(`BigQuery Days: ${this.overallStats.bigQueryDays}`);
        reportLines.push(`TradeStation Days: ${this.overallStats.tradestationDays}`);
        reportLines.push('');
        
        // Daily Results
        reportLines.push('DAILY RESULTS');
        reportLines.push('-'.repeat(30));
        
        for (const dayResult of this.dailyResults) {
            reportLines.push(`${dayResult.date.toDateString()} [${dayResult.dataSource || 'TradeStation'}]`);
            reportLines.push(`  SPX Bars: ${dayResult.spxBars}`);
            reportLines.push(`  Entry Signals: ${dayResult.entrySignals}`);
            reportLines.push(`  Exit Signals: ${dayResult.exitSignals}`);
            reportLines.push(`  Net P&L: $${dayResult.netPnL.toFixed(2)}`);
            reportLines.push(`  Status: ${dayResult.message}`);
            
            // Trade details with enhanced information
            if (dayResult.trades.length > 0) {
                reportLines.push('  Trades:');
                for (let i = 0; i < dayResult.trades.length; i++) {
                    const trade = dayResult.trades[i];
                    
                    // Convert timestamps to proper Eastern Time
                    const entryTimeET = TimezoneUtils.toEasternTimeString(trade.entry.timestamp);
                    const exitTimeET = TimezoneUtils.toEasternTimeString(trade.exit.timestamp);
                    
                    // Calculate hold time
                    const holdTimeMinutes = Math.round((new Date(trade.exit.timestamp) - new Date(trade.entry.timestamp)) / 60000);
                    
                    reportLines.push(`    ${i+1}. ${trade.entry.symbol}`);
                    reportLines.push(`       Entry: $${trade.entry.optionPrice.toFixed(2)} at ${entryTimeET}`);
                    reportLines.push(`              SPX: ${trade.entry.spxPrice.toFixed(2)}, MACD: ${trade.entry.macd.toFixed(4)}, Signal: ${trade.entry.signal.toFixed(4)}, Hist: ${trade.entry.histogram.toFixed(4)}`);
                    reportLines.push(`       Exit:  $${trade.exit.optionPrice.toFixed(2)} at ${exitTimeET} (${holdTimeMinutes}min)`);
                    reportLines.push(`              SPX: ${trade.exit.spxPrice.toFixed(2)}, MACD: ${trade.exit.macd.toFixed(4)}, Signal: ${trade.exit.signal.toFixed(4)}, Hist: ${trade.exit.histogram.toFixed(4)}`);
                    reportLines.push(`       P&L:   $${trade.exit.profit.toFixed(2)}`);
                    reportLines.push(`       Exit Reason: ${trade.exit.reason}`);
                    
                    // Add data source information if available
                    if (trade.entry.dataSource) {
                        reportLines.push(`       Data Source: ${trade.entry.dataSource}`);
                    }
                }
            }
            reportLines.push('');
        }
        
        // Save report
        const reportContent = reportLines.join('\n');
        const reportPath = path.join(__dirname, 'backtest_results', `spx_20day_backtest_${new Date().toISOString().split('T')[0]}.txt`);
        
        // Ensure directory exists
        const dir = path.dirname(reportPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(reportPath, reportContent);
        
        console.log('\n📄 ENHANCED BACKTEST COMPLETE');
        console.log('='.repeat(60));
        console.log(`Report saved to: ${reportPath}`);
        console.log(`Net P&L: $${this.overallStats.netPnL.toFixed(2)}`);
        console.log(`Total Trades: ${this.overallStats.totalTrades}`);
        console.log(`Win Rate: ${this.overallStats.winRate.toFixed(1)}%`);
        console.log(`Negative Crossover Exits: ${this.overallStats.negativeCrossoverExits} (${(this.overallStats.negativeCrossoverExits/Math.max(this.overallStats.totalTrades,1)*100).toFixed(1)}%)`);
        console.log(`BigQuery Days: ${this.overallStats.bigQueryDays}, TradeStation Days: ${this.overallStats.tradestationDays}`);
        
        return reportPath;
    }
}

// Main execution
async function main() {
    try {
        const backtest = new SPX20DayBacktest();
        await backtest.runBacktest();
    } catch (error) {
        console.error('❌ Backtest failed:', error);
        process.exit(1);
    }
}

// Export for testing
module.exports = {
    TradingDateUtils,
    TradeStationDataClient,
    MACDStudy,
    SPXBacktestStrategy,
    SPX20DayBacktest
};

// Run if called directly
if (require.main === module) {
    main();
}