#!/usr/bin/env node

/**
 * SPX Straddle Strategy Backtest
 * 
 * Strategy:
 * 1. At 9:33 AM (3 minutes after open), get SPX price
 * 2. Buy ATM straddle (call + put at nearest strike)
 * 3. Exit on target profit, stop loss, or end of day
 * 
 * Usage:
 * node spx-straddle-backtest.js [daysBack] [targetProfit%] [stopLoss%]
 * Example: node spx-straddle-backtest.js 40 20 50
 */

require('dotenv').config();
const { BigQuery } = require('@google-cloud/bigquery');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration from command line args
const DAYS_BACK = parseInt(process.argv[2]) || 40;
const TARGET_PROFIT = parseFloat(process.argv[3]) || 20; // Default 20% target
const STOP_LOSS = process.argv[4] ? parseFloat(process.argv[4]) : null; // Optional, null = hold to EOD

console.log('🚀 SPX Straddle Strategy Backtest');
console.log('==================================');
console.log(`📊 Configuration:`);
console.log(`   Days Back: ${DAYS_BACK}`);
console.log(`   Target Profit: ${TARGET_PROFIT}%`);
console.log(`   Stop Loss: ${STOP_LOSS ? STOP_LOSS + '%' : 'None (hold to EOD)'}`);
console.log(`   Entry Time: 9:33 AM ET (3 min after open)`);
console.log('');

// BigQuery client
const bigquery = new BigQuery({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'your-project-id'
});

// TradeStation API configuration
const TS_API_KEY = process.env.TRADESTATION_API_KEY || '';
const TS_API_SECRET = process.env.TRADESTATION_API_SECRET || '';
const TS_BASE_URL = 'https://api.tradestation.com/v3';

let accessToken = null;

/**
 * Authenticate with TradeStation using refresh token
 */
async function authenticateTradeStation() {
  try {
    const refreshToken = process.env.TRADESTATION_REFRESH_TOKEN;
    if (!refreshToken) {
      throw new Error('TRADESTATION_REFRESH_TOKEN not found in environment');
    }

    // Use the correct OAuth endpoint like in spx-20day-backtest
    const authUrl = 'https://signin.tradestation.com';
    const response = await axios.post(`${authUrl}/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: process.env.TRADESTATION_CLIENT_ID,
      client_secret: process.env.TRADESTATION_CLIENT_SECRET,
      refresh_token: refreshToken
    });

    accessToken = response.data.access_token;
    console.log('✅ Authenticated with TradeStation');
    console.log(`   Access token expires in: ${response.data.expires_in} seconds\n`);
    return accessToken;
  } catch (error) {
    console.error('❌ TradeStation authentication failed:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get SPX opening price from TradeStation for a specific date
 */
async function getSPXOpeningPrice(date) {
  try {
    const dateStr = date.toISOString().split('T')[0];
    // Use Eastern time for market hours (9:30 AM ET = 13:30 or 14:30 UTC depending on DST)
    // For 9:33 AM ET (3 minutes after open), we need data from 9:30 to 9:35
    const startTime = `${dateStr}T13:30:00Z`; // 9:30 AM ET
    const endTime = `${dateStr}T13:35:00Z`;   // 9:35 AM ET

    console.log(`   🔍 Fetching SPX price from TradeStation for ${dateStr}...`);
    
    const response = await axios.get(`${TS_BASE_URL}/marketdata/barcharts/$SPX.X`, {
      params: {
        interval: '1',
        unit: 'Minute',
        firstdate: startTime,  // Use firstdate instead of start
        lastdate: endTime      // Use lastdate instead of end
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.Bars && response.data.Bars.length > 0) {
      // Get the price at 9:33 (3rd minute bar)
      const bars = response.data.Bars;
      const targetBar = bars[3] || bars[bars.length - 1]; // 9:33 or last available
      const spxPrice = parseFloat(targetBar.Close);
      
      // Validate SPX price is reasonable
      if (spxPrice > 10000 || spxPrice < 3000 || isNaN(spxPrice)) {
        console.log(`   ❌ Invalid SPX price: $${spxPrice} - skipping day`);
        throw new Error(`Invalid SPX price: ${spxPrice}`);
      }
      
      return spxPrice;
    }

    throw new Error(`No SPX data for ${dateStr}`);
  } catch (error) {
    console.error(`   ❌ TradeStation API error: ${error.message}`);
    throw error; // Re-throw to skip this day
  }
}

/**
 * Get nearest strike price (SPX strikes are in $5 increments)
 */
function getNearestStrike(spxPrice) {
  // Round to nearest 5
  return Math.round(spxPrice / 5) * 5;
}

/**
 * Get option data from BigQuery for a specific date and strike
 */
async function getOptionDataFromBigQuery(date, strike) {
  const dateStr = date.toISOString().split('T')[0];
  
  // For 0DTE, we need the same day expiration
  // For other days, we use the nearest Friday
  const dayOfWeek = date.getDay();
  let expirationDate = new Date(date);
  
  if (dayOfWeek === 5) {
    // It's Friday, use same day (0DTE)
    // Keep expiration as is
  } else {
    // Find next Friday
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    expirationDate.setDate(date.getDate() + daysUntilFriday);
  }
  
  const expDateStr = expirationDate.toISOString().split('T')[0];
  
  const query = `
    WITH call_data AS (
      SELECT 
        TimeStamp as timestamp,
        OptionSymbol as symbol,
        Open as open,
        High as high,
        Low as low,
        Close as close,
        TotalVolume as volume,
        Strike as strike,
        'CALL' as option_type
      FROM \`galvanic-ripsaw-381707.spx_all.spx_option_call_barcharts\`
      WHERE CreatedDate = '${dateStr}'
        AND Strike = ${strike}
    ),
    put_data AS (
      SELECT 
        TimeStamp as timestamp,
        OptionSymbol as symbol,
        Open as open,
        High as high,
        Low as low,
        Close as close,
        TotalVolume as volume,
        Strike as strike,
        'PUT' as option_type
      FROM \`galvanic-ripsaw-381707.spx_all.spx_option_put_barcharts\`
      WHERE CreatedDate = '${dateStr}'
        AND Strike = ${strike}
    )
    SELECT 
      option_type,
      timestamp,
      symbol,
      open,
      high,
      low,
      close,
      volume
    FROM call_data
    UNION ALL
    SELECT 
      option_type,
      timestamp,
      symbol,
      open,
      high,
      low,
      close,
      volume
    FROM put_data
    ORDER BY timestamp, option_type
  `;

  console.log(`   📊 BigQuery Query for ${dateStr}, Strike ${strike}:`);
  console.log(`      Dataset: galvanic-ripsaw-381707.spx_all`);
  console.log(`      Tables: spx_option_call_barcharts, spx_option_put_barcharts`);
  console.log(`      WHERE: CreatedDate = '${dateStr}' AND Strike = ${strike}`);
  
  try {
    const [rows] = await bigquery.query({ query });
    
    if (!rows || rows.length === 0) {
      console.log(`   ❌ No BigQuery data found (0 rows returned)`);
      console.log(`      Possible reasons:`);
      console.log(`      - No options traded at strike ${strike} on ${dateStr}`);
      console.log(`      - Data not yet loaded for this date`);
      console.log(`      Skipping day - no synthetic data`);
      throw new Error(`No option data for strike ${strike} on ${dateStr}`);
    }
    
    console.log(`   ✅ Found ${rows.length} data points in BigQuery`);
    
    // Process the data into time series
    const callPrices = [];
    const putPrices = [];
    
    rows.forEach(row => {
      // Use close price, or average of open/close if close is missing
      const price = row.close || ((row.open + row.high + row.low) / 3) || row.open || 0;
      const timeStr = new Date(row.timestamp.value || row.timestamp).toTimeString().split(' ')[0];
      
      if (row.option_type === 'CALL') {
        callPrices.push({ time: timeStr, price: price });
      } else if (row.option_type === 'PUT') {
        putPrices.push({ time: timeStr, price: price });
      }
    });
    
    return { callPrices, putPrices };
  } catch (error) {
    console.error(`BigQuery error for ${dateStr}:`, error.message);
    throw error; // Re-throw to skip this day
  }
}


/**
 * Backtest a single day
 */
async function backtestDay(date) {
  const dateStr = date.toISOString().split('T')[0];
  console.log(`\n📅 Backtesting ${dateStr}...`);
  
  // Get SPX opening price from TradeStation
  const spxPrice = await getSPXOpeningPrice(date);
  const strike = getNearestStrike(spxPrice);
  
  console.log(`   SPX @ 9:33 AM: $${spxPrice.toFixed(2)}`);
  console.log(`   Selected Strike: $${strike}`);
  
  // Get option data from BigQuery
  const { callPrices, putPrices } = await getOptionDataFromBigQuery(date, strike);
  
  if (callPrices.length === 0 || putPrices.length === 0) {
    console.log(`   ❌ Insufficient option data for ${dateStr} - skipping day`);
    throw new Error(`Insufficient option data for ${dateStr}`);
  }
  
  // Entry prices (first available prices around 9:33)
  const callEntry = callPrices[0].price;
  const putEntry = putPrices[0].price;
  const totalEntry = callEntry + putEntry;
  
  console.log(`   Call Entry: $${callEntry.toFixed(2)}`);
  console.log(`   Put Entry: $${putEntry.toFixed(2)}`);
  console.log(`   Total Entry: $${totalEntry.toFixed(2)}`);
  
  // Calculate target and stop prices
  const targetPrice = totalEntry * (1 + TARGET_PROFIT / 100);
  const stopPrice = STOP_LOSS ? totalEntry * (1 - STOP_LOSS / 100) : 0;
  
  // Track position throughout the day
  let exitFound = false;
  let exitTime = null;
  let exitReason = null;
  let callExit = null;
  let putExit = null;
  let maxProfit = 0;
  let maxLoss = 0;
  
  // Check prices throughout the day
  const minLength = Math.min(callPrices.length, putPrices.length);
  for (let i = 0; i < minLength; i++) {
    const callPrice = callPrices[i].price;
    const putPrice = putPrices[i].price;
    const totalPrice = callPrice + putPrice;
    const profit = totalPrice - totalEntry;
    const profitPercent = (profit / totalEntry) * 100;
    
    // Track max profit/loss
    maxProfit = Math.max(maxProfit, profit);
    maxLoss = Math.min(maxLoss, profit);
    
    // Check exit conditions
    if (!exitFound) {
      // Target profit hit
      if (totalPrice >= targetPrice) {
        callExit = callPrice;
        putExit = putPrice;
        exitTime = callPrices[i].time;
        exitReason = 'TARGET';
        exitFound = true;
        const exitPnL = totalPrice - totalEntry;
        console.log(`   ✅ Target hit at ${exitTime}: +${profitPercent.toFixed(1)}% | P&L: $${exitPnL.toFixed(2)}`);
      }
      // Stop loss hit
      else if (stopPrice > 0 && totalPrice <= stopPrice) {
        callExit = callPrice;
        putExit = putPrice;
        exitTime = callPrices[i].time;
        exitReason = 'STOP';
        exitFound = true;
        const exitPnL = totalPrice - totalEntry;
        console.log(`   ❌ Stop loss hit at ${exitTime}: ${profitPercent.toFixed(1)}% | P&L: $${exitPnL.toFixed(2)}`);
      }
    }
  }
  
  // If no exit during day, use closing prices
  if (!exitFound) {
    callExit = callPrices[callPrices.length - 1].price;
    putExit = putPrices[putPrices.length - 1].price;
    exitTime = '16:00:00';
    exitReason = 'EOD';
    const eodPnL = callExit + putExit - totalEntry;
    const finalProfit = (eodPnL / totalEntry) * 100;
    console.log(`   ⏰ EOD exit: ${finalProfit.toFixed(1)}% | P&L: $${eodPnL.toFixed(2)}`);
  }
  
  const totalExit = callExit + putExit;
  const pnl = totalExit - totalEntry;
  const pnlPercent = (pnl / totalEntry) * 100;
  
  return {
    date: dateStr,
    spxPrice: spxPrice.toFixed(2),
    strike,
    callEntry: callEntry.toFixed(2),
    putEntry: putEntry.toFixed(2),
    totalEntry: totalEntry.toFixed(2),
    callExit: callExit.toFixed(2),
    putExit: putExit.toFixed(2),
    totalExit: totalExit.toFixed(2),
    exitTime,
    exitReason,
    pnl: pnl.toFixed(2),
    pnlPercent: pnlPercent.toFixed(2),
    maxProfit: maxProfit.toFixed(2),
    maxLoss: maxLoss.toFixed(2)
  };
}

/**
 * Get trading days (excluding weekends) - most recent first
 */
function getTradingDays(daysBack) {
  const days = [];
  const today = new Date();
  let currentDate = new Date(today);
  
  // Start from yesterday (not today since market may still be open)
  currentDate.setDate(currentDate.getDate() - 1);
  
  while (days.length < daysBack) {
    const dayOfWeek = currentDate.getDay();
    
    // Skip weekends (0 = Sunday, 6 = Saturday)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      days.push(new Date(currentDate));
    }
    
    currentDate.setDate(currentDate.getDate() - 1);
  }
  
  return days; // Return most recent first (no reverse)
}

/**
 * Generate report
 */
function generateReport(results) {
  console.log('\n' + '='.repeat(80));
  console.log('📈 BACKTEST RESULTS SUMMARY');
  console.log('='.repeat(80));
  
  const validResults = results.filter(r => r !== null);
  
  if (validResults.length === 0) {
    console.log('❌ No valid results to report');
    return;
  }
  
  const wins = validResults.filter(r => parseFloat(r.pnl) > 0);
  const losses = validResults.filter(r => parseFloat(r.pnl) <= 0);
  const targetHits = validResults.filter(r => r.exitReason === 'TARGET');
  const stopHits = validResults.filter(r => r.exitReason === 'STOP');
  const eodExits = validResults.filter(r => r.exitReason === 'EOD');
  
  const totalPnL = validResults.reduce((sum, r) => sum + parseFloat(r.pnl), 0);
  const avgEntry = validResults.reduce((sum, r) => sum + parseFloat(r.totalEntry), 0) / validResults.length;
  const avgPnL = totalPnL / validResults.length;
  const winRate = (wins.length / validResults.length) * 100;
  
  console.log(`\n📊 PERFORMANCE METRICS:`);
  console.log(`   Total Trading Days: ${validResults.length}`);
  console.log(`   Winning Days: ${wins.length} (${winRate.toFixed(1)}%)`);
  console.log(`   Losing Days: ${losses.length} (${(100 - winRate).toFixed(1)}%)`);
  console.log(`   Win Rate: ${winRate.toFixed(1)}%`);
  console.log('');
  console.log(`💰 P&L SUMMARY:`);
  console.log(`   Total P&L: $${totalPnL.toFixed(2)}`);
  console.log(`   Average Daily P&L: $${avgPnL.toFixed(2)}`);
  console.log(`   Average Entry Cost: $${avgEntry.toFixed(2)}`);
  console.log(`   Total Capital Used: $${(avgEntry * validResults.length).toFixed(2)}`);
  console.log(`   Return on Capital: ${((totalPnL / (avgEntry * validResults.length)) * 100).toFixed(2)}%`);
  
  if (wins.length > 0) {
    const avgWin = wins.reduce((sum, r) => sum + parseFloat(r.pnl), 0) / wins.length;
    console.log(`   Average Win: $${avgWin.toFixed(2)}`);
  }
  
  if (losses.length > 0) {
    const avgLoss = losses.reduce((sum, r) => sum + parseFloat(r.pnl), 0) / losses.length;
    console.log(`   Average Loss: $${avgLoss.toFixed(2)}`);
  }
  
  console.log('');
  console.log(`🎯 EXIT BREAKDOWN:`);
  console.log(`   Target Hit: ${targetHits.length} trades (${((targetHits.length / validResults.length) * 100).toFixed(1)}%)`);
  if (targetHits.length > 0) {
    const targetPnL = targetHits.reduce((sum, r) => sum + parseFloat(r.pnl), 0);
    console.log(`      → Total P&L: $${targetPnL.toFixed(2)}`);
    console.log(`      → Avg P&L: $${(targetPnL / targetHits.length).toFixed(2)}`);
  }
  
  console.log(`   Stop Loss: ${stopHits.length} trades (${((stopHits.length / validResults.length) * 100).toFixed(1)}%)`);
  if (stopHits.length > 0) {
    const stopPnL = stopHits.reduce((sum, r) => sum + parseFloat(r.pnl), 0);
    console.log(`      → Total P&L: $${stopPnL.toFixed(2)}`);
    console.log(`      → Avg P&L: $${(stopPnL / stopHits.length).toFixed(2)}`);
  }
  
  console.log(`   End of Day: ${eodExits.length} trades (${((eodExits.length / validResults.length) * 100).toFixed(1)}%)`);
  if (eodExits.length > 0) {
    const eodPnL = eodExits.reduce((sum, r) => sum + parseFloat(r.pnl), 0);
    console.log(`      → Total P&L: $${eodPnL.toFixed(2)}`);
    console.log(`      → Avg P&L: $${(eodPnL / eodExits.length).toFixed(2)}`);
  }
  
  // Best and worst trades
  const bestTrade = validResults.reduce((best, r) => 
    parseFloat(r.pnl) > parseFloat(best?.pnl || -999999) ? r : best
  );
  const worstTrade = validResults.reduce((worst, r) => 
    parseFloat(r.pnl) < parseFloat(worst?.pnl || 999999) ? r : worst
  );
  
  console.log('');
  console.log(`📈 BEST DAY:`);
  console.log(`   Date: ${bestTrade.date}`);
  console.log(`   Entry: $${bestTrade.totalEntry} (Strike: ${bestTrade.strike})`);
  console.log(`   Exit: $${bestTrade.totalExit} at ${bestTrade.exitTime}`);
  console.log(`   P&L: $${bestTrade.pnl} (${bestTrade.pnlPercent}%)`);
  console.log(`   Exit Reason: ${bestTrade.exitReason}`);
  
  console.log('');
  console.log(`📉 WORST DAY:`);
  console.log(`   Date: ${worstTrade.date}`);
  console.log(`   Entry: $${worstTrade.totalEntry} (Strike: ${worstTrade.strike})`);
  console.log(`   Exit: $${worstTrade.totalExit} at ${worstTrade.exitTime}`);
  console.log(`   P&L: $${worstTrade.pnl} (${worstTrade.pnlPercent}%)`);
  console.log(`   Exit Reason: ${worstTrade.exitReason}`);
  
  // Add final summary stats
  console.log('');
  console.log('=' .repeat(80));
  console.log(`🏁 FINAL SUMMARY:`);
  console.log(`   Strategy: SPX ATM Straddle`);
  console.log(`   Period: ${validResults[0]?.date} to ${validResults[validResults.length-1]?.date}`);
  console.log(`   Days Tested: ${validResults.length}`);
  console.log(`   Target/Stop: ${TARGET_PROFIT}% / ${STOP_LOSS ? STOP_LOSS + '%' : 'None'}`);
  console.log(`   Net Result: ${totalPnL >= 0 ? '✅ PROFITABLE' : '❌ LOSS'} - $${totalPnL.toFixed(2)}`);
  console.log('=' .repeat(80));
  
  // Save results to file
  saveResults(validResults);
}

/**
 * Save results to CSV file
 */
function saveResults(results) {
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `backtest_results/spx_straddle_${timestamp}.csv`;
  
  // Create directory if it doesn't exist
  const dir = path.dirname(filename);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // Create CSV content
  const headers = 'Date,SPX_Price,Strike,Call_Entry,Put_Entry,Total_Entry,Call_Exit,Put_Exit,Total_Exit,Exit_Time,Exit_Reason,PnL,PnL_Percent,Max_Profit,Max_Loss';
  const rows = results.map(r => 
    `${r.date},${r.spxPrice},${r.strike},${r.callEntry},${r.putEntry},${r.totalEntry},` +
    `${r.callExit},${r.putExit},${r.totalExit},${r.exitTime},${r.exitReason},` +
    `${r.pnl},${r.pnlPercent},${r.maxProfit},${r.maxLoss}`
  );
  
  const csv = [headers, ...rows].join('\n');
  fs.writeFileSync(filename, csv);
  
  console.log(`\n💾 Detailed results saved to: ${filename}`);
}

/**
 * Main execution
 */
async function main() {
  try {
    // Authenticate with TradeStation
    await authenticateTradeStation();
    
    // Get trading days
    const tradingDays = getTradingDays(DAYS_BACK);
    console.log(`📊 Backtesting ${tradingDays.length} trading days`);
    console.log('=' .repeat(60));
    
    // Process each day
    const results = [];
    for (const day of tradingDays) {
      try {
        const result = await backtestDay(day);
        results.push(result);
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`❌ Skipping ${day.toISOString().split('T')[0]}:`, error.message);
      }
    }
    
    // Generate report
    generateReport(results);
    
    console.log('\n✅ Backtest completed successfully!');
    
  } catch (error) {
    console.error('❌ Backtest failed:', error);
    process.exit(1);
  }
}

// Run the backtest
main();