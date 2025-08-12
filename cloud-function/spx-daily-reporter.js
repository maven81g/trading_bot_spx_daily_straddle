const axios = require('axios');
const { BigQueryClient } = require('./bigquery-client');
const { EmailClient } = require('./email-client');

/**
 * Trading Date Utilities (copied from backtest)
 */
class TradingDateUtils {
    static isWeekday(date) {
        const day = date.getDay();
        return day >= 1 && day <= 5; // Monday = 1, Friday = 5
    }
    
    static formatDateForAPI(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}

/**
 * Timezone Utilities for proper Eastern Time conversion
 */
class TimezoneUtils {
    /**
     * Convert UTC timestamp to Eastern Time string
     * @param {string} utcTimestamp - UTC timestamp
     * @returns {string} Eastern Time string (HH:MM:SS EDT/EST)
     */
    static toEasternTimeString(utcTimestamp) {
        const date = new Date(utcTimestamp);
        const easternTime = date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        
        const isDST = this.isDaylightSavingTime(date);
        const timezone = isDST ? 'EDT' : 'EST';
        
        return `${easternTime} ${timezone}`;
    }
    
    /**
     * Check if date is within trading hours (9:30 AM - 4:00 PM ET)
     * @param {string} utcTimestamp - UTC timestamp
     * @returns {boolean} True if within trading hours
     */
    static isWithinTradingHours(utcTimestamp) {
        const date = new Date(utcTimestamp);
        const easternHour = parseInt(date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            hour: '2-digit'
        }));
        const easternMinute = parseInt(date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            minute: '2-digit'
        }));
        
        const totalMinutes = easternHour * 60 + easternMinute;
        const marketOpen = 9 * 60 + 30;  // 9:30 AM
        const marketClose = 16 * 60;     // 4:00 PM
        
        return totalMinutes >= marketOpen && totalMinutes <= marketClose;
    }
    
    /**
     * Check if timestamp is within entry hours (9:30 AM - 3:30 PM ET)
     * No new entries allowed after 3:30 PM since options expire at 4:00 PM
     * @param {string} utcTimestamp - UTC timestamp
     * @returns {boolean} True if within entry hours
     */
    static isWithinEntryHours(utcTimestamp) {
        const date = new Date(utcTimestamp);
        const easternHour = parseInt(date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            hour: '2-digit'
        }));
        const easternMinute = parseInt(date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            minute: '2-digit'
        }));
        
        const totalMinutes = easternHour * 60 + easternMinute;
        const marketOpen = 9 * 60 + 30;  // 9:30 AM
        const entryCutoff = 15 * 60 + 30; // 3:30 PM
        
        return totalMinutes >= marketOpen && totalMinutes <= entryCutoff;
    }
    
    /**
     * Check if date is in daylight saving time
     * @param {Date} date - Date to check
     * @returns {boolean} True if in DST
     */
    static isDaylightSavingTime(date) {
        const january = new Date(date.getFullYear(), 0, 1);
        const july = new Date(date.getFullYear(), 6, 1);
        const stdOffset = Math.max(january.getTimezoneOffset(), july.getTimezoneOffset());
        return date.getTimezoneOffset() < stdOffset;
    }
}

/**
 * TradeStation API Client (refactored from backtest)
 */
class TradeStationDataClient {
    constructor() {
        this.baseURL = 'https://sim-api.tradestation.com/v3';
        this.accessToken = null;
        this.refreshToken = null;
        this.requestCount = 0;
        this.cache = new Map();
    }
    
    async authenticateWithRefreshToken(clientId, clientSecret, refreshToken) {
        console.log('🔐 Authenticating with TradeStation...');
        this.refreshToken = refreshToken;
        
        try {
            const response = await axios.post('https://signin.tradestation.com/oauth/token', {
                grant_type: 'refresh_token',
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken
            });
            
            this.accessToken = response.data.access_token;
            console.log('✅ TradeStation authentication successful');
            return true;
        } catch (error) {
            console.error('❌ TradeStation authentication failed:', error.response?.data || error.message);
            return false;
        }
    }
    
    async fetchSPXData(date) {
        const dateStr = TradingDateUtils.formatDateForAPI(date);
        const cacheKey = `spx_${dateStr}`;
        
        if (this.cache.has(cacheKey)) {
            console.log(`📊 Using cached SPX data for ${dateStr}`);
            return this.cache.get(cacheKey);
        }
        
        const startTime = `${dateStr}T13:30:00Z`; // 9:30 AM EST
        const endTime = `${dateStr}T21:00:00Z`;   // 5:00 PM EST
        
        const url = `${this.baseURL}/marketdata/barcharts/$SPXW.X?unit=minute&firstdate=${startTime}&lastdate=${endTime}`;
        
        try {
            console.log(`📊 Fetching SPX data for ${dateStr}...`);
            console.log(`🔗 URL: ${url}`);
            console.log(`⏰ Start time: ${startTime}, End time: ${endTime}`);
            
            const response = await axios.get(url, {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            
            this.requestCount++;
            const result = {
                success: true,
                data: response.data,
                barCount: response.data.Bars?.length || 0
            };
            
            this.cache.set(cacheKey, result);
            console.log(`✅ Fetched ${result.barCount} SPX bars`);
            return result;
            
        } catch (error) {
            console.error(`❌ Failed to fetch SPX data for ${dateStr}`);
            console.error(`🔗 Failed URL: ${url}`);
            console.error(`📋 Error details:`, error.response?.data || error.message);
            console.error(`📋 Status code:`, error.response?.status);
            console.error(`📋 Status text:`, error.response?.statusText);
            
            // Return more detailed error info
            const errorDetails = error.response?.data ? 
                JSON.stringify(error.response.data) : 
                error.message;
            
            return { 
                success: false, 
                error: `${error.message} - Details: ${errorDetails}`,
                statusCode: error.response?.status,
                url: url
            };
        }
    }
    
    async fetchOptionData(symbol, date) {
        const dateStr = TradingDateUtils.formatDateForAPI(date);
        const cacheKey = `option_${symbol}_${dateStr}`;
        
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }
        
        const encodedSymbol = encodeURIComponent(symbol);
        const startTime = `${dateStr}T13:30:00Z`;
        const endTime = `${dateStr}T21:00:00Z`;
        
        const url = `${this.baseURL}/marketdata/barcharts/${encodedSymbol}?unit=minute&firstdate=${startTime}&lastdate=${endTime}`;
        
        try {
            const response = await axios.get(url, {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            
            this.requestCount++;
            const result = {
                success: true,
                data: response.data,
                barCount: response.data.Bars?.length || 0
            };
            
            this.cache.set(cacheKey, result);
            return result;
            
        } catch (error) {
            console.error(`❌ Failed to fetch option data for ${symbol}:`, error.response?.data || error.message);
            return { success: false, error: error.message };
        }
    }
}

/**
 * MACD Study (copied from backtest)
 */
class MACDStudy {
    constructor(fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        this.fastPeriod = fastPeriod;
        this.slowPeriod = slowPeriod;
        this.signalPeriod = signalPeriod;
        
        this.prices = [];
        this.fastEMA = null;
        this.slowEMA = null;
        this.macdLine = [];
        this.signalLine = null;
        this.previousSignal = null;
    }
    
    addBar(bar) {
        const price = parseFloat(bar.Close);
        this.prices.push(price);
        
        // Calculate EMAs
        if (this.fastEMA === null && this.prices.length >= this.fastPeriod) {
            this.fastEMA = this.calculateSMA(this.prices.slice(-this.fastPeriod));
        } else if (this.fastEMA !== null) {
            this.fastEMA = this.calculateEMA(price, this.fastEMA, this.fastPeriod);
        }
        
        if (this.slowEMA === null && this.prices.length >= this.slowPeriod) {
            this.slowEMA = this.calculateSMA(this.prices.slice(-this.slowPeriod));
        } else if (this.slowEMA !== null) {
            this.slowEMA = this.calculateEMA(price, this.slowEMA, this.slowPeriod);
        }
        
        // Calculate MACD line
        if (this.fastEMA !== null && this.slowEMA !== null) {
            const macdValue = this.fastEMA - this.slowEMA;
            this.macdLine.push(macdValue);
            
            // Calculate Signal line (EMA of MACD)
            if (this.signalLine === null && this.macdLine.length >= this.signalPeriod) {
                this.signalLine = this.calculateSMA(this.macdLine.slice(-this.signalPeriod));
            } else if (this.signalLine !== null) {
                this.signalLine = this.calculateEMA(macdValue, this.signalLine, this.signalPeriod);
            }
        }
    }
    
    calculateSMA(values) {
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }
    
    calculateEMA(price, previousEMA, period) {
        const multiplier = 2 / (period + 1);
        return (price * multiplier) + (previousEMA * (1 - multiplier));
    }
    
    getCurrentValues() {
        if (this.macdLine.length === 0 || this.signalLine === null) {
            return null;
        }
        
        const macd = this.macdLine[this.macdLine.length - 1];
        const signal = this.signalLine;
        const histogram = macd - signal;
        
        // Detect crossover
        let crossover = 'none';
        if (this.previousSignal !== null) {
            const previousMACD = this.macdLine[this.macdLine.length - 2] || macd;
            if (previousMACD <= this.previousSignal && macd > signal) {
                crossover = 'bullish'; // MACD crosses above Signal
            } else if (previousMACD >= this.previousSignal && macd < signal) {
                crossover = 'bearish'; // MACD crosses below Signal
            }
        }
        
        this.previousSignal = signal;
        
        return { macd, signal, histogram, crossover };
    }
    
    reset() {
        this.prices = [];
        this.fastEMA = null;
        this.slowEMA = null;
        this.macdLine = [];
        this.signalLine = null;
        this.previousSignal = null;
    }
}

/**
 * SPX Strategy (refactored from backtest)
 */
class SPXBacktestStrategy {
    constructor() {
        this.macdStudy = new MACDStudy();
        this.entrySignals = [];
        this.exitSignals = [];
        this.currentPosition = null;
        this.previousHistogram = null;
        this.histogramHistory = []; // Track last 4 histogram values for 4-bar trend analysis
        this.macdHistory = []; // Track last 4 MACD values to check threshold condition before crossover
        this.macdThreshold = -1.0; // Updated from -2.0 to -1.0
        this.profitTarget = 1.0; // $1 profit target
        this.stopLossPercent = -20.0; // 20% stop loss
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
    
    processBar(bar, optionDataMap) {
        this.macdStudy.addBar(bar);
        const macdValues = this.macdStudy.getCurrentValues();
        
        if (!macdValues) return [];
        
        const signals = [];
        
        // Debug logging for crossover detection
        if (macdValues.crossover === 'bullish') {
            const wasBelowThreshold = this.wasMacdBelowThreshold(macdValues.macd);
            const isIncreasing = this.isHistogramIncreasing(macdValues.histogram);
            const withinHours = TimezoneUtils.isWithinEntryHours(bar.TimeStamp);
            const noPosition = !this.currentPosition;
            
            console.log(`🔍 Bullish crossover at ${bar.TimeStamp} (${TimezoneUtils.toEasternTimeString(bar.TimeStamp)}): MACD=${macdValues.macd.toFixed(4)}, Histogram=${macdValues.histogram.toFixed(4)}`);
            console.log(`   Entry conditions: NoPosition=${noPosition}, MACD_WAS≤-1=${wasBelowThreshold}, Histogram↑=${isIncreasing}, WithinHours=${withinHours}`);
            
            if (isIncreasing && this.histogramHistory.length >= 3) {
                const last4Values = [...this.histogramHistory.slice(-3), macdValues.histogram];
                console.log(`   Histogram 4-bar pattern: [${last4Values.map(v => v.toFixed(4)).join(' → ')}] - ${isIncreasing ? '✅ INCREASING' : '❌ NOT INCREASING'}`);
            } else {
                console.log(`   Histogram history too short: ${this.histogramHistory.length} bars`);
            }
        }
        
        // Entry Logic: MACD ≤ -1, bullish crossover, histogram increasing over last 4 bars including current (no entries after 3:30 PM ET)
        if (!this.currentPosition && 
            macdValues.macd <= this.macdThreshold && 
            macdValues.crossover === 'bullish' &&
            this.isHistogramIncreasing(macdValues.histogram) &&
            TimezoneUtils.isWithinEntryHours(bar.TimeStamp)) {
            
            const optionSymbol = this.constructOptionSymbol(bar);
            const optionData = optionDataMap.get(optionSymbol) || [];
            const optionPrice = this.getOptionPrice(optionSymbol, bar.TimeStamp, optionData);
            
            const signal = {
                type: 'ENTRY',
                symbol: optionSymbol,
                spxPrice: parseFloat(bar.Close),
                optionPrice: optionPrice,
                timestamp: bar.TimeStamp,
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
                entryMacd: macdValues.macd,
                entrySignal: macdValues.signal,
                entryHistogram: macdValues.histogram,
                spxEntryPrice: parseFloat(bar.Close),
                initialHistogram: macdValues.histogram
            };
        }
        
        // Exit Logic
        if (this.currentPosition) {
            const optionData = optionDataMap.get(this.currentPosition.symbol) || [];
            const currentOptionPrice = this.getOptionPrice(this.currentPosition.symbol, bar.TimeStamp, optionData);
            const dollarProfit = (currentOptionPrice - this.currentPosition.entryPrice) * 100;
            const percentProfit = ((currentOptionPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) * 100;
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
        
        // Update histories AFTER processing signals (keep last 4 values each for trend analysis)
        this.histogramHistory.push(macdValues.histogram);
        if (this.histogramHistory.length > 4) {
            this.histogramHistory.shift();
        }
        
        this.macdHistory.push(macdValues.macd);
        if (this.macdHistory.length > 4) {
            this.macdHistory.shift();
        }
        
        return signals;
    }
    
    constructOptionSymbol(bar) {
        const date = new Date(bar.TimeStamp);
        const spxPrice = parseFloat(bar.Close);
        const strike = Math.floor(spxPrice / 5) * 5;
        
        const year = date.getFullYear().toString().slice(-2);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return `SPXW ${year}${month}${day}C${strike}`;
    }
    
    getOptionPrice(optionSymbol, timestamp, optionData) {
        if (optionData.length === 0) {
            console.warn(`⚠️ No option data for ${optionSymbol}, using estimate`);
            return 1.0;
        }
        
        // Find exact timestamp match
        for (const optionBar of optionData) {
            if (optionBar.TimeStamp === timestamp) {
                return parseFloat(optionBar.Close);
            }
        }
        
        // Find closest timestamp (within 5 minutes)
        const targetTime = new Date(timestamp).getTime();
        let closest = null;
        let closestDiff = Infinity;
        
        for (const optionBar of optionData) {
            const barTime = new Date(optionBar.TimeStamp).getTime();
            const diff = Math.abs(targetTime - barTime);
            
            if (diff < closestDiff && diff <= 5 * 60 * 1000) { // Within 5 minutes
                closest = optionBar;
                closestDiff = diff;
            }
        }
        
        if (closest) {
            console.log(`✅ Found close match for ${optionSymbol} at ${closest.TimeStamp}: $${closest.Close} (${Math.round(closestDiff/1000)}s diff)`);
            return parseFloat(closest.Close);
        }
        
        console.warn(`⚠️ No close timestamp match for ${optionSymbol}, using first available: $${optionData[0].Close}`);
        return parseFloat(optionData[0].Close);
    }
    
    getResults() {
        return {
            entrySignals: this.entrySignals,
            exitSignals: this.exitSignals,
            totalTrades: Math.min(this.entrySignals.length, this.exitSignals.length),
            currentPosition: this.currentPosition
        };
    }
    
    reset() {
        this.macdStudy.reset();
        this.entrySignals = [];
        this.exitSignals = [];
        this.currentPosition = null;
        this.previousHistogram = null;
    }
}

/**
 * Main Daily Reporter Class
 */
class SPXDailyReporter {
    constructor(config) {
        this.config = config;
        this.dataClient = new TradeStationDataClient();
        this.bigqueryClient = new BigQueryClient(config.projectId, config.dataset);
        this.emailClient = new EmailClient(config.mailgunApiKey, config.mailgunDomain, config.emailFrom);
        this.strategy = new SPXBacktestStrategy();
        
        console.log('🎯 SPX Daily Reporter initialized');
    }
    
    /**
     * Run daily analysis for a specific date
     */
    async runDailyAnalysis(targetDate) {
        const startTime = Date.now();
        console.log(`🚀 Starting daily analysis for ${targetDate.toDateString()}`);
        
        // Authenticate with TradeStation
        const authenticated = await this.dataClient.authenticateWithRefreshToken(
            this.config.tradestationClientId,
            this.config.tradestationClientSecret, 
            this.config.tradestationRefreshToken
        );
        if (!authenticated) {
            throw new Error('Failed to authenticate with TradeStation API');
        }
        
        // Fetch SPX data
        const spxResult = await this.dataClient.fetchSPXData(targetDate);
        if (!spxResult.success || spxResult.barCount === 0) {
            throw new Error(`Failed to fetch SPX data: ${spxResult.error || 'No bars returned'}`);
        }
        
        const spxBars = spxResult.data.Bars;
        console.log(`📊 Processing ${spxBars.length} SPX bars`);
        
        // Pre-analyze to find potential strikes
        const potentialStrikes = this.findPotentialStrikes(spxBars);
        console.log(`🎯 Identified ${potentialStrikes.size} potential strikes`);
        
        // Fetch option data for potential strikes
        const optionDataMap = await this.fetchOptionData(Array.from(potentialStrikes), targetDate);
        
        // Run strategy
        this.strategy.reset();
        for (const bar of spxBars) {
            this.strategy.processBar(bar, optionDataMap);
        }
        
        // Generate report
        const report = this.generateDailyReport(targetDate, spxBars, this.strategy.getResults(), startTime);
        
        // Store in BigQuery
        const bigqueryStored = await this.storeToBigQuery(report);
        
        // Send email summary
        const recentPerformance = await this.bigqueryClient.getRecentSummaries(10);
        const emailSent = await this.sendEmailSummary(report, recentPerformance);
        
        console.log(`✅ Daily analysis completed for ${targetDate.toDateString()}`);
        
        return {
            ...report,
            bigqueryStored,
            emailSent
        };
    }
    
    /**
     * Find potential option strikes based on SPX movement
     */
    findPotentialStrikes(spxBars) {
        const strikes = new Set();
        const tempStrategy = new SPXBacktestStrategy();
        
        // Analyze first 150 bars to identify potential strikes (covers ~11:30 AM ET)
        for (const bar of spxBars.slice(0, 150)) {
            tempStrategy.macdStudy.addBar(bar);
            const macdValues = tempStrategy.macdStudy.getCurrentValues();
            
            if (macdValues && macdValues.macd < -1.0) {
                const spxPrice = parseFloat(bar.Close);
                const strike = Math.floor(spxPrice / 5) * 5;
                
                // Add nearby strikes for coverage
                for (let offset = -10; offset <= 10; offset += 5) {
                    strikes.add(strike + offset);
                }
            }
        }
        
        return strikes;
    }
    
    /**
     * Fetch option data for multiple strikes
     */
    async fetchOptionData(strikes, targetDate) {
        const optionDataMap = new Map();
        const dateStr = TradingDateUtils.formatDateForAPI(targetDate);
        
        console.log(`📊 Fetching option data for ${strikes.length} strikes...`);
        
        for (const strike of strikes) {
            const year = targetDate.getFullYear().toString().slice(-2);
            const month = String(targetDate.getMonth() + 1).padStart(2, '0');
            const day = String(targetDate.getDate()).padStart(2, '0');
            const optionSymbol = `SPXW ${year}${month}${day}C${strike}`;
            
            const optionResult = await this.dataClient.fetchOptionData(optionSymbol, targetDate);
            
            if (optionResult.success && optionResult.barCount > 0) {
                optionDataMap.set(optionSymbol, optionResult.data.Bars);
                console.log(`✅ Loaded ${optionResult.barCount} bars for ${optionSymbol}`);
            }
        }
        
        console.log(`📊 Successfully loaded option data for ${optionDataMap.size} strikes`);
        return optionDataMap;
    }
    
    /**
     * Generate daily report structure
     */
    generateDailyReport(date, spxBars, strategyResults, startTime) {
        const executionTime = (Date.now() - startTime) / 1000;
        const dateStr = TradingDateUtils.formatDateForAPI(date);
        
        // Calculate market data
        const marketOpen = parseFloat(spxBars[0].Close);
        const marketClose = parseFloat(spxBars[spxBars.length - 1].Close);
        const dailyChange = marketClose - marketOpen;
        const dailyChangePercent = (dailyChange / marketOpen) * 100;
        
        // Process trades
        const trades = this.processTradesForReport(strategyResults, dateStr);
        
        // Calculate summary statistics
        const summary = this.calculateSummaryStats(trades, strategyResults);
        
        return {
            date: dateStr,
            strategy: 'MACD_Momentum',
            market_data: {
                trading_day: date.toDateString(),
                spx_bars_count: spxBars.length,
                market_open_spx: marketOpen,
                market_close_spx: marketClose,
                spx_daily_change: dailyChange,
                spx_daily_change_percent: dailyChangePercent
            },
            summary: {
                ...summary,
                api_requests_made: this.dataClient.requestCount,
                execution_time_seconds: executionTime,
                cloud_function_version: this.config.version
            },
            trades
        };
    }
    
    /**
     * Process trades for report format
     */
    processTradesForReport(strategyResults, dateStr) {
        const trades = [];
        const completedTrades = Math.min(strategyResults.entrySignals.length, strategyResults.exitSignals.length);
        
        for (let i = 0; i < completedTrades; i++) {
            const entry = strategyResults.entrySignals[i];
            const exit = strategyResults.exitSignals[i];
            
            // Calculate hold duration
            const entryTime = new Date(entry.timestamp);
            const exitTime = new Date(exit.timestamp);
            const holdDuration = Math.round((exitTime - entryTime) / (1000 * 60)); // minutes
            
            // Calculate P&L percentage
            const pnlPercent = (exit.profit / (entry.optionPrice * 100)) * 100;
            
            // Extract strike price from symbol
            const strikeMatch = entry.symbol.match(/C(\d+)$/);
            const strikePrice = strikeMatch ? parseInt(strikeMatch[1]) : 0;
            
            // Convert to Eastern Time (proper timezone conversion)
            const entryTimeET = TimezoneUtils.toEasternTimeString(entry.timestamp);
            const exitTimeET = TimezoneUtils.toEasternTimeString(exit.timestamp);
            
            trades.push({
                date: dateStr,
                trade_id: `${dateStr.replace(/-/g, '')}_${String(i + 1).padStart(3, '0')}`,
                symbol: entry.symbol,
                strike_price: strikePrice,
                // Entry details
                entry_time: entryTime.toISOString(),
                entry_time_est: entryTimeET,
                entry_price: entry.optionPrice,
                entry_spx_price: entry.spxPrice,
                entry_macd: entry.macd,
                entry_signal: entry.signal,
                entry_histogram: entry.histogram,
                // Exit details
                exit_time: exitTime.toISOString(),
                exit_time_est: exitTimeET,
                exit_price: exit.optionPrice,
                exit_spx_price: exit.spxPrice,
                exit_macd: exit.macd,
                exit_signal: exit.signal,
                exit_histogram: exit.histogram,
                // Trade results
                hold_duration_minutes: holdDuration,
                pnl: exit.profit,
                pnl_percent: pnlPercent,
                exit_reason: exit.reason,
                is_winner: exit.profit > 0,
                trade_sequence: i + 1
            });
        }
        
        return trades;
    }
    
    /**
     * Calculate summary statistics
     */
    calculateSummaryStats(trades, strategyResults) {
        const totalTrades = trades.length;
        const winningTrades = trades.filter(t => t.is_winner).length;
        const losingTrades = totalTrades - winningTrades;
        
        const totalProfit = trades.filter(t => t.is_winner).reduce((sum, t) => sum + t.pnl, 0);
        const totalLoss = trades.filter(t => !t.is_winner).reduce((sum, t) => sum + t.pnl, 0);
        
        const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
        const averageWin = winningTrades > 0 ? totalProfit / winningTrades : 0;
        const averageLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
        
        return {
            entry_signals: strategyResults.entrySignals.length,
            exit_signals: strategyResults.exitSignals.length,
            total_trades: totalTrades,
            winning_trades: winningTrades,
            losing_trades: losingTrades,
            win_rate: winRate,
            total_profit: totalProfit,
            total_loss: totalLoss,
            net_pnl: totalProfit + totalLoss,
            average_win: averageWin,
            average_loss: averageLoss
        };
    }
    
    /**
     * Store results to BigQuery
     */
    async storeToBigQuery(report) {
        try {
            // Store daily summary
            const summaryData = {
                ...report.market_data,
                ...report.summary,
                date: report.date,
                strategy: report.strategy
            };
            
            await this.bigqueryClient.storeDailySummary(summaryData);
            
            // Store individual trades
            if (report.trades.length > 0) {
                await this.bigqueryClient.storeTrades(report.trades);
            }
            
            console.log('✅ Data stored to BigQuery successfully');
            return true;
        } catch (error) {
            console.error('❌ Failed to store to BigQuery:', error);
            return false;
        }
    }
    
    /**
     * Send email summary
     */
    async sendEmailSummary(report, recentPerformance) {
        try {
            await this.emailClient.sendDailySummary(
                this.config.emailTo,
                report,
                recentPerformance
            );
            
            console.log('✅ Email summary sent successfully');
            return true;
        } catch (error) {
            console.error('❌ Failed to send email:', error);
            return false;
        }
    }
}

module.exports = { SPXDailyReporter };