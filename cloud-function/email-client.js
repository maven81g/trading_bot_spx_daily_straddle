const mailgun = require('mailgun-js');

/**
 * Email client using Mailgun for sending trading reports
 */
class EmailClient {
    constructor(apiKey, domain, fromEmail) {
        this.mg = mailgun({ apiKey, domain });
        this.fromEmail = fromEmail;
        
        console.log(`📧 Mailgun client initialized for domain: ${domain}`);
    }
    
    /**
     * Send daily trading summary email
     * @param {string} toEmail - Recipient email address
     * @param {Object} reportData - Daily report data
     * @param {Array} recentPerformance - Recent daily performance for context
     */
    async sendDailySummary(toEmail, reportData, recentPerformance = []) {
        console.log(`📧 Sending daily summary email to ${toEmail}...`);
        
        const { date, summary, trades, market_data } = reportData;
        const pnlSign = summary.net_pnl >= 0 ? '+' : '';
        const pnlFormatted = `${pnlSign}$${summary.net_pnl.toFixed(2)}`;
        
        const subject = `Daily SPX Options Report - ${date} - P&L: ${pnlFormatted}`;
        
        const htmlBody = this.generateEmailHTML(reportData, recentPerformance);
        const textBody = this.generateEmailText(reportData, recentPerformance);
        
        const emailData = {
            from: this.fromEmail,
            to: toEmail,
            subject: subject,
            html: htmlBody,
            text: textBody
        };
        
        try {
            const result = await this.mg.messages().send(emailData);
            console.log(`✅ Email sent successfully: ${result.id}`);
            return { success: true, messageId: result.id };
        } catch (error) {
            console.error('❌ Failed to send email:', error);
            throw error;
        }
    }
    
    /**
     * Generate HTML email content
     */
    generateEmailHTML(reportData, recentPerformance) {
        const { date, summary, trades, market_data } = reportData;
        const pnlClass = summary.net_pnl >= 0 ? 'profit' : 'loss';
        const pnlSign = summary.net_pnl >= 0 ? '+' : '';
        
        // Recent performance chart data
        const recentPnLs = recentPerformance.slice(0, 10).map(day => 
            `<span class="${day.net_pnl >= 0 ? 'profit' : 'loss'}">${day.date}: ${day.net_pnl >= 0 ? '+' : ''}$${day.net_pnl.toFixed(0)}</span>`
        ).join(' | ');
        
        return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; }
        .header { background: #1f2937; color: white; padding: 20px; text-align: center; }
        .summary { background: #f8fafc; padding: 20px; margin: 20px 0; border-radius: 8px; }
        .profit { color: #10b981; font-weight: bold; }
        .loss { color: #ef4444; font-weight: bold; }
        .neutral { color: #6b7280; }
        table { border-collapse: collapse; width: 100%; margin: 20px 0; }
        th, td { border: 1px solid #d1d5db; padding: 12px; text-align: left; }
        th { background: #f3f4f6; font-weight: bold; }
        .trade-win { background: #ecfdf5; }
        .trade-loss { background: #fef2f2; }
        .footer { background: #f3f4f6; padding: 15px; margin-top: 30px; font-size: 0.9em; color: #6b7280; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
        .stat-card { background: white; padding: 15px; border-radius: 6px; border: 1px solid #e5e7eb; }
        .recent-performance { font-size: 0.9em; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>📈 SPX Daily Options Report</h1>
        <h2>${date}</h2>
        <h3 class="${pnlClass}">P&L: ${pnlSign}$${summary.net_pnl.toFixed(2)}</h3>
    </div>
    
    <div class="summary">
        <h3>📊 Daily Summary</h3>
        <div class="stats-grid">
            <div class="stat-card">
                <strong>Total Trades:</strong> ${summary.total_trades}<br>
                <strong>Win Rate:</strong> ${(summary.win_rate * 100).toFixed(1)}%
            </div>
            <div class="stat-card">
                <strong>Winning Trades:</strong> ${summary.winning_trades}<br>
                <strong>Losing Trades:</strong> ${summary.losing_trades}
            </div>
            <div class="stat-card">
                <strong>Total Profit:</strong> <span class="profit">$${summary.total_profit.toFixed(2)}</span><br>
                <strong>Total Loss:</strong> <span class="loss">$${Math.abs(summary.total_loss).toFixed(2)}</span>
            </div>
            <div class="stat-card">
                <strong>SPX Daily Change:</strong> <span class="${market_data.spx_daily_change >= 0 ? 'profit' : 'loss'}">${market_data.spx_daily_change >= 0 ? '+' : ''}${market_data.spx_daily_change.toFixed(2)} (${market_data.spx_daily_change_percent >= 0 ? '+' : ''}${market_data.spx_daily_change_percent.toFixed(2)}%)</span><br>
                <strong>SPX Range:</strong> ${market_data.market_open_spx.toFixed(2)} - ${market_data.market_close_spx.toFixed(2)}
            </div>
        </div>
        
        ${recentPnLs ? `<div class="recent-performance"><strong>Recent 10 Days:</strong> ${recentPnLs}</div>` : ''}
    </div>
    
    ${trades.length > 0 ? `
    <h3>🎯 Trade Details</h3>
    <table>
        <thead>
            <tr>
                <th>#</th>
                <th>Strike</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Duration</th>
                <th>P&L</th>
                <th>Exit Reason</th>
            </tr>
        </thead>
        <tbody>
            ${trades.map((trade, i) => `
            <tr class="${trade.is_winner ? 'trade-win' : 'trade-loss'}">
                <td>${i + 1}</td>
                <td>${trade.strike_price}</td>
                <td>$${trade.entry_price.toFixed(2)} @ ${trade.entry_time_est}</td>
                <td>$${trade.exit_price.toFixed(2)} @ ${trade.exit_time_est}</td>
                <td>${trade.hold_duration_minutes}min</td>
                <td class="${trade.is_winner ? 'profit' : 'loss'}">${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}</td>
                <td>${trade.exit_reason}</td>
            </tr>
            `).join('')}
        </tbody>
    </table>
    ` : '<p>ℹ️ No trades executed today.</p>'}
    
    <div class="footer">
        <p><strong>Strategy:</strong> MACD Momentum (Entry: MACD < -2.0 + Bullish Crossover, Exit: $1+ Profit + Momentum Shrinking OR 20% Stop Loss)</p>
        <p><strong>Data Source:</strong> TradeStation API | <strong>Storage:</strong> BigQuery | <strong>Generated:</strong> ${new Date().toISOString()}</p>
        <p><a href="https://console.cloud.google.com/bigquery">📊 View in BigQuery</a></p>
    </div>
</body>
</html>`;
    }
    
    /**
     * Generate plain text email content
     */
    generateEmailText(reportData, recentPerformance) {
        const { date, summary, trades, market_data } = reportData;
        const pnlSign = summary.net_pnl >= 0 ? '+' : '';
        
        let text = `SPX DAILY OPTIONS REPORT - ${date}\n`;
        text += `${'='.repeat(50)}\n\n`;
        
        text += `SUMMARY:\n`;
        text += `P&L: ${pnlSign}$${summary.net_pnl.toFixed(2)}\n`;
        text += `Total Trades: ${summary.total_trades}\n`;
        text += `Win Rate: ${(summary.win_rate * 100).toFixed(1)}%\n`;
        text += `Winning Trades: ${summary.winning_trades}\n`;
        text += `Losing Trades: ${summary.losing_trades}\n`;
        text += `Total Profit: $${summary.total_profit.toFixed(2)}\n`;
        text += `Total Loss: $${Math.abs(summary.total_loss).toFixed(2)}\n\n`;
        
        text += `MARKET DATA:\n`;
        text += `SPX Open: ${market_data.market_open_spx.toFixed(2)}\n`;
        text += `SPX Close: ${market_data.market_close_spx.toFixed(2)}\n`;
        text += `Daily Change: ${market_data.spx_daily_change >= 0 ? '+' : ''}${market_data.spx_daily_change.toFixed(2)} (${market_data.spx_daily_change_percent >= 0 ? '+' : ''}${market_data.spx_daily_change_percent.toFixed(2)}%)\n\n`;
        
        if (trades.length > 0) {
            text += `TRADES:\n`;
            trades.forEach((trade, i) => {
                text += `${i + 1}. Strike ${trade.strike_price}: `;
                text += `$${trade.entry_price.toFixed(2)} → $${trade.exit_price.toFixed(2)} `;
                text += `(${trade.hold_duration_minutes}min) `;
                text += `P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}\n`;
                text += `   ${trade.exit_reason}\n`;
            });
        } else {
            text += `No trades executed today.\n`;
        }
        
        text += `\nStrategy: MACD Momentum with 20% Stop Loss\n`;
        text += `Generated: ${new Date().toISOString()}\n`;
        
        return text;
    }
    
    /**
     * Send error notification email
     * @param {string} toEmail - Recipient email address
     * @param {Error} error - Error object
     * @param {string} date - Date string
     */
    async sendErrorNotification(toEmail, error, date) {
        console.log(`📧 Sending error notification to ${toEmail}...`);
        
        const emailData = {
            from: this.fromEmail,
            to: toEmail,
            subject: `❌ SPX Daily Trader Failed - ${date}`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <h2 style="color: #ef4444;">❌ SPX Daily Trader Error</h2>
                    <p><strong>Date:</strong> ${date}</p>
                    <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
                    <p><strong>Error:</strong> ${error.message}</p>
                    <pre style="background: #f3f4f6; padding: 15px; border-radius: 5px; overflow-x: auto;">
${error.stack}
                    </pre>
                    <p>Please check the Cloud Function logs for more details.</p>
                </div>
            `,
            text: `SPX Daily Trader Error - ${date}\n\nError: ${error.message}\n\nStack:\n${error.stack}`
        };
        
        try {
            const result = await this.mg.messages().send(emailData);
            console.log(`✅ Error notification sent: ${result.id}`);
            return { success: true, messageId: result.id };
        } catch (emailError) {
            console.error('❌ Failed to send error notification:', emailError);
            throw emailError;
        }
    }
}

module.exports = { EmailClient };