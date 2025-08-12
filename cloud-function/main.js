const functions = require('@google-cloud/functions-framework');
const { SPXDailyReporter } = require('./spx-daily-reporter');

/**
 * Google Cloud Function entry point
 * Triggers daily SPX options trading analysis
 */
functions.http('main', async (req, res) => {
    console.log('🎯 SPX Daily Trader Cloud Function started');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Method: ${req.method}`);
    console.log(`Headers: ${JSON.stringify(req.headers, null, 2)}`);
    
    const startTime = Date.now();
    
    try {
        // Initialize the daily reporter
        const reporter = new SPXDailyReporter({
            projectId: 'galvanic-ripsaw-381707',
            dataset: process.env.BIGQUERY_DATASET || 'spx_trading',
            mailgunApiKey: process.env.mailgun_api_key,
            mailgunDomain: 'sandboxabd41b3728e64b64bd08b04b93c7d783.mailgun.org',
            emailTo: 'ulises81g@gmail.com',
            emailFrom: 'ulises81g@gmail.com',
            tradestationClientId: process.env.ts_client_id,
            tradestationClientSecret: process.env.ts_client_secret,
            tradestationRefreshToken: process.env.ts_refresh_token,
            version: process.env.CLOUD_FUNCTION_VERSION || '1.0.0'
        });
        
        // Validate required environment variables
        const requiredEnvVars = [
            'mailgun_api_key',
            'ts_client_id',
            'ts_client_secret',
            'ts_refresh_token'
        ];
        
        const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
        if (missingVars.length > 0) {
            throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
        }
        
        // Allow manual date override via query parameter for testing
        const targetDate = req.query.date ? new Date(req.query.date) : new Date();
        console.log(`📅 Target trading date: ${targetDate.toDateString()}`);
        
        // Check if it's a weekend (no trading)
        const dayOfWeek = targetDate.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            const message = `⚠️ Skipping execution - ${targetDate.toDateString()} is a weekend`;
            console.log(message);
            
            res.status(200).json({
                success: true,
                message: message,
                skipped: true,
                date: targetDate.toDateString()
            });
            return;
        }
        
        // Run the daily trading analysis
        console.log('🚀 Starting daily SPX options analysis...');
        const result = await reporter.runDailyAnalysis(targetDate);
        
        const executionTime = (Date.now() - startTime) / 1000;
        console.log(`✅ Analysis completed successfully in ${executionTime}s`);
        console.log(`📊 Results: ${result.summary.total_trades} trades, P&L: $${result.summary.net_pnl}`);
        
        // Send success response
        res.status(200).json({
            success: true,
            message: 'Daily SPX analysis completed successfully',
            execution_time_seconds: executionTime,
            date: targetDate.toDateString(),
            summary: {
                total_trades: result.summary.total_trades,
                net_pnl: result.summary.net_pnl,
                win_rate: result.summary.win_rate,
                email_sent: result.emailSent,
                bigquery_stored: result.bigqueryStored
            }
        });
        
    } catch (error) {
        const executionTime = (Date.now() - startTime) / 1000;
        console.error('❌ SPX Daily Trader failed:', error);
        console.error('Stack trace:', error.stack);
        
        // Try to send error email if possible
        try {
            if (process.env.mailgun_api_key) {
                const mailgun = require('mailgun-js')({
                    apiKey: process.env.mailgun_api_key,
                    domain: 'sandboxabd41b3728e64b64bd08b04b93c7d783.mailgun.org'
                });
                
                await mailgun.messages().send({
                    from: 'ulises81g@gmail.com',
                    to: 'ulises81g@gmail.com',
                    subject: `❌ SPX Daily Trader Failed - ${new Date().toDateString()}`,
                    html: `
                        <h2>SPX Daily Trader Error</h2>
                        <p><strong>Date:</strong> ${new Date().toISOString()}</p>
                        <p><strong>Execution Time:</strong> ${executionTime}s</p>
                        <p><strong>Error:</strong> ${error.message}</p>
                        <pre>${error.stack}</pre>
                    `
                });
                console.log('📧 Error notification email sent');
            }
        } catch (emailError) {
            console.error('Failed to send error email:', emailError);
        }
        
        // Send error response
        res.status(500).json({
            success: false,
            error: error.message,
            execution_time_seconds: executionTime,
            timestamp: new Date().toISOString()
        });
    }
});