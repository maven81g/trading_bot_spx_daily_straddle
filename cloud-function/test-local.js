/**
 * Local Test Script for SPX Daily Reporter
 * Tests the core functionality before Cloud Function deployment
 */

require('dotenv').config();
const { SPXDailyReporter } = require('./spx-daily-reporter');

console.log('🧪 SPX Daily Reporter - Local Test');
console.log('=' * 50);

async function testLocalExecution() {
    try {
        // Check environment variables
        console.log('📋 Checking environment variables...');
        const requiredVars = [
            'GOOGLE_CLOUD_PROJECT',
            'ts_client_id',
            'ts_client_secret', 
            'ts_refresh_token',
            'mailgun_api_key'
        ];
        
        const missingVars = requiredVars.filter(varName => !process.env[varName]);
        if (missingVars.length > 0) {
            console.error(`❌ Missing environment variables: ${missingVars.join(', ')}`);
            console.log('\n💡 Create a .env file with the required variables:');
            console.log('   cp .env.example .env');
            console.log('   # Edit .env with your actual values');
            return;
        }
        
        console.log('✅ All environment variables are set');
        
        // Initialize reporter
        console.log('\n🎯 Initializing SPX Daily Reporter...');
        const reporter = new SPXDailyReporter({
            projectId: process.env.GOOGLE_CLOUD_PROJECT,
            dataset: process.env.BIGQUERY_DATASET || 'spx_trading',
            mailgunApiKey: process.env.mailgun_api_key,
            mailgunDomain: 'sandboxabd41b3728e64b64bd08b04b93c7d783.mailgun.org',
            emailTo: 'ulises81g@gmail.com',
            emailFrom: 'ulises81g@gmail.com',
            tradestationClientId: process.env.ts_client_id,
            tradestationClientSecret: process.env.ts_client_secret,
            tradestationRefreshToken: process.env.ts_refresh_token,
            version: process.env.CLOUD_FUNCTION_VERSION || '1.0.0-test'
        });
        
        // Determine test date
        const testDateArg = process.argv.find(arg => arg.startsWith('--date='));
        const testDate = testDateArg ? new Date(testDateArg.split('=')[1]) : new Date('2025-07-31');
        
        console.log(`📅 Test date: ${testDate.toDateString()}`);
        
        // Check if it's a weekend
        const dayOfWeek = testDate.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            console.log('⚠️  Warning: Test date is a weekend (no trading data expected)');
        }
        
        // Run the analysis
        console.log('\n🚀 Running daily analysis...');
        const startTime = Date.now();
        
        const result = await reporter.runDailyAnalysis(testDate);
        
        const executionTime = (Date.now() - startTime) / 1000;
        
        // Display results
        console.log('\n📊 TEST RESULTS:');
        console.log('=' * 30);
        console.log(`Execution Time: ${executionTime.toFixed(2)}s`);
        console.log(`Date: ${result.date}`);
        console.log(`Strategy: ${result.strategy}`);
        console.log(`SPX Bars: ${result.market_data.spx_bars_count}`);
        console.log(`Total Trades: ${result.summary.total_trades}`);
        console.log(`Win Rate: ${(result.summary.win_rate * 100).toFixed(1)}%`);
        console.log(`Net P&L: $${result.summary.net_pnl.toFixed(2)}`);
        console.log(`API Requests: ${result.summary.api_requests_made}`);
        console.log(`BigQuery Stored: ${result.bigqueryStored ? '✅' : '❌'}`);
        console.log(`Email Sent: ${result.emailSent ? '✅' : '❌'}`);
        
        if (result.trades.length > 0) {
            console.log('\n🎯 TRADE DETAILS:');
            result.trades.forEach((trade, i) => {
                const pnlSign = trade.pnl >= 0 ? '+' : '';
                console.log(`${i + 1}. Strike ${trade.strike_price}: $${trade.entry_price.toFixed(2)} → $${trade.exit_price.toFixed(2)} (${trade.hold_duration_minutes}min) P&L: ${pnlSign}$${trade.pnl.toFixed(2)}`);
                console.log(`   ${trade.exit_reason}`);
            });
        } else {
            console.log('\nℹ️  No trades executed');
        }
        
        console.log('\n📈 MARKET DATA:');
        console.log(`SPX Open: ${result.market_data.market_open_spx.toFixed(2)}`);
        console.log(`SPX Close: ${result.market_data.market_close_spx.toFixed(2)}`);
        console.log(`Daily Change: ${result.market_data.spx_daily_change >= 0 ? '+' : ''}${result.market_data.spx_daily_change.toFixed(2)} (${result.market_data.spx_daily_change_percent >= 0 ? '+' : ''}${result.market_data.spx_daily_change_percent.toFixed(2)}%)`);
        
        console.log('\n✅ Local test completed successfully!');
        
        // Test suggestions
        console.log('\n💡 NEXT STEPS:');
        console.log('1. Check your email for the summary report');
        console.log('2. Verify data in BigQuery console');
        console.log('3. If everything looks good, deploy with: ./deploy.sh');
        
        if (!result.bigqueryStored) {
            console.log('\n⚠️  BigQuery storage failed - check your project ID and dataset');
        }
        
        if (!result.emailSent) {
            console.log('\n⚠️  Email sending failed - check your Mailgun configuration');
        }
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error('Stack trace:', error.stack);
        
        // Common error suggestions
        console.log('\n🔧 TROUBLESHOOTING:');
        
        if (error.message.includes('TradeStation')) {
            console.log('- Check your TRADESTATION_REFRESH_TOKEN');
            console.log('- Ensure the refresh token is valid and not expired');
        }
        
        if (error.message.includes('BigQuery')) {
            console.log('- Verify GOOGLE_CLOUD_PROJECT is correct');
            console.log('- Ensure BigQuery tables are created');
            console.log('- Check Google Cloud authentication');
        }
        
        if (error.message.includes('Mailgun') || error.message.includes('email')) {
            console.log('- Verify Mailgun API key and domain');
            console.log('- Check EMAIL_TO and EMAIL_FROM addresses');
        }
        
        if (error.message.includes('No bars') || error.message.includes('SPX data')) {
            console.log('- Try a different date (recent weekday)');
            console.log('- Check if the date has trading data available');
        }
        
        process.exit(1);
    }
}

// Mock mode for testing without actual API calls
const mockMode = process.argv.includes('--mock');
if (mockMode) {
    console.log('🎭 Running in MOCK mode (no actual BigQuery/Email calls)');
    
    // Mock BigQuery client
    const originalBigQuery = require('./bigquery-client').BigQueryClient;
    require('./bigquery-client').BigQueryClient = class MockBigQueryClient extends originalBigQuery {
        async storeDailySummary(data) {
            console.log('🎭 MOCK: Would store daily summary:', JSON.stringify(data, null, 2));
            return true;
        }
        
        async storeTrades(trades) {
            console.log(`🎭 MOCK: Would store ${trades.length} trades`);
            return true;
        }
        
        async getRecentSummaries(days) {
            console.log(`🎭 MOCK: Would query last ${days} summaries`);
            return [];
        }
    };
    
    // Mock Email client
    const originalEmail = require('./email-client').EmailClient;
    require('./email-client').EmailClient = class MockEmailClient extends originalEmail {
        async sendDailySummary(toEmail, reportData, recentPerformance) {
            console.log(`🎭 MOCK: Would send email to ${toEmail}`);
            console.log('Subject:', `Daily SPX Options Report - ${reportData.date} - P&L: $${reportData.summary.net_pnl.toFixed(2)}`);
            return { success: true, messageId: 'mock-12345' };
        }
    };
}

// Help message
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('\nUsage: node test-local.js [options]');
    console.log('\nOptions:');
    console.log('  --date=YYYY-MM-DD    Test with specific date (default: 2025-07-31)');
    console.log('  --mock               Run in mock mode (no actual BigQuery/Email calls)');
    console.log('  --help, -h           Show this help message');
    console.log('\nExamples:');
    console.log('  node test-local.js');
    console.log('  node test-local.js --date=2025-08-01');
    console.log('  node test-local.js --mock');
    console.log('  node test-local.js --date=2025-07-31 --mock');
    console.log('\nEnvironment:');
    console.log('  Create .env file with required variables (see .env.example)');
    process.exit(0);
}

// Run the test
testLocalExecution();