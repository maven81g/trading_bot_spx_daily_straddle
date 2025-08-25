# SPX Straddle Bot - Local Setup Guide

This guide will help you set up the SPX Straddle Bot to run locally on Windows with auto-restart capabilities, state persistence, and comprehensive monitoring.

## 🚀 Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Start the Bot**
   ```bash
   # For manual operation
   npm run start

   # For auto-restart (recommended)
   .\run-bot-local.bat
   ```

## 📋 Prerequisites

- Node.js 18+ installed
- TradeStation developer account and API credentials
- Windows 10/11 (for Windows notifications and Task Scheduler)

## 🔧 Configuration

### Required Settings

Edit your `.env` file with these required values:

```env
TRADESTATION_CLIENT_ID=your_client_id_here
TRADESTATION_CLIENT_SECRET=your_client_secret_here
TRADESTATION_REFRESH_TOKEN=your_refresh_token_here
TRADESTATION_ACCOUNT_ID=your_account_id_here
```

### Notification Setup (Recommended)

**Mailgun Email** (Recommended for reliability):
```env
MAILGUN_API_KEY=your_mailgun_api_key
MAILGUN_DOMAIN=your-domain.com
MAILGUN_FROM=SPX Bot <bot@your-domain.com>
MAILGUN_TO=your-email@domain.com
```

**Discord** (For real-time alerts):
```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook-url
DISCORD_USER_ID=your-user-id-for-mentions
```

**Pushover** (For mobile notifications):
```env
PUSHOVER_USER_KEY=your_pushover_user_key
PUSHOVER_API_TOKEN=your_pushover_api_token
```

## 🛠️ Auto-Restart Setup

### Option 1: Batch Script (Simple)

Run the bot with automatic restart on crashes:
```bash
.\run-bot-local.bat
```

This script:
- Automatically restarts the bot if it crashes
- Adjusts restart intervals based on market hours
- Logs all activity to `logs/bot_YYYYMMDD.log`
- Can be stopped with `.\stop-bot.bat`

### Option 2: Windows Task Scheduler (Advanced)

For system-level reliability and auto-start on boot:

1. **Run as Administrator**:
   ```bash
   .\setup-task-scheduler.bat
   ```

2. **Verify Setup**:
   - Open Task Scheduler (`taskschd.msc`)
   - Look for "SPX_Straddle_Bot" task
   - Check it's enabled and scheduled properly

3. **Manual Control**:
   ```bash
   # Start the scheduled task
   schtasks /run /tn "SPX_Straddle_Bot"

   # Stop the scheduled task
   schtasks /end /tn "SPX_Straddle_Bot"

   # Check task status
   schtasks /query /tn "SPX_Straddle_Bot"
   ```

## 📊 Monitoring & State Management

### State Persistence

The bot automatically saves its state to `data/bot-state.json`:
- Current positions
- Daily P&L
- Trade history
- Market data timestamps

State is saved every 30 seconds and on shutdown. If the bot restarts, it will restore the previous state.

### Heartbeat Monitoring

The bot includes comprehensive health monitoring:
- **System Heartbeat**: Every 5 minutes to configured webhook
- **Data Stream Monitor**: Every 60 seconds for market data health
- **Automatic Reconnection**: For dead data streams
- **Health Snapshots**: Saved during graceful shutdowns

### Log Files

All activity is logged to:
- `logs/straddle-bot.log` - Main bot activity
- `logs/heartbeat.log` - System health monitoring
- `logs/bot_YYYYMMDD.log` - Daily batch script logs

## 🔔 Notification Types

The bot sends notifications for:

**Trade Events**:
- Position opened
- Position closed
- P&L updates

**System Events**:
- Bot startup/shutdown
- Data stream issues
- Critical errors
- Daily summary (4:30 PM ET)

**Monitoring Alerts**:
- Heartbeat failures
- Stream disconnections
- System errors

## ⚙️ Advanced Configuration

### Trading Strategy

```env
ENTRY_TIME=13:46        # Entry time in ET (24-hour format)
TARGET_PROFIT=20        # Profit target percentage
STOP_LOSS=50           # Stop loss percentage (optional)
EXIT_TIME=15:50        # End-of-day exit time
MAX_POSITION_VALUE=10000 # Maximum position size in dollars
```

### System Settings

```env
LOG_LEVEL=info         # Logging verbosity (debug, info, warn, error)
TESTING=false          # Enable debug mode
PAPER_TRADING=true     # Use paper trading (recommended for testing)
```

## 🚨 Safety & Best Practices

### Initial Testing

1. **Start with Paper Trading**:
   ```env
   PAPER_TRADING=true
   TRADESTATION_SANDBOX=true
   ```

2. **Test All Notifications**: Verify all notification channels work before going live

3. **Monitor for Several Days**: Ensure the bot handles market conditions correctly

### Production Deployment

1. **Switch to Live Mode**:
   ```env
   PAPER_TRADING=false
   TRADESTATION_SANDBOX=false
   TRADESTATION_API_URL=https://api.tradestation.com/v3
   ```

2. **Set Up Monitoring**: Configure at least email notifications

3. **Schedule Daily Checks**: Review logs and P&L daily

## 🔧 Troubleshooting

### Common Issues

**Bot Won't Start**:
- Check `.env` configuration
- Verify TradeStation credentials
- Review `logs/straddle-bot.log` for errors

**No Market Data**:
- Check internet connection
- Verify TradeStation account permissions
- Look for stream reconnection messages

**Notifications Not Working**:
- Test each service individually
- Check API keys and credentials
- Review notification service logs

### Debug Mode

Enable detailed logging:
```env
LOG_LEVEL=debug
TESTING=true
```

### Manual Commands

```bash
# Check bot status
npm run status

# View recent logs
Get-Content logs/straddle-bot.log -Tail 50

# Test notifications
npm run test:notifications
```

## 📈 Performance Optimization

### System Resources

- **CPU**: Minimal usage (~1-2%)
- **Memory**: ~50-100MB RAM
- **Disk**: Logs rotate, ~1GB for historical data
- **Network**: Low bandwidth for market data

### Scaling Considerations

- Bot is designed for single-instrument (SPX) trading
- Can handle multiple notification channels simultaneously
- State management scales with trade frequency

## 🆘 Support & Updates

### Getting Help

1. Check logs first: `logs/straddle-bot.log`
2. Review configuration: `.env` file
3. Test components individually
4. Check TradeStation API status

### Regular Maintenance

- Review logs weekly
- Clean up old log files monthly
- Update dependencies quarterly
- Monitor notification delivery

## 📄 File Structure

```
trading_bot_spx_daily_straddle/
├── src/
│   ├── spx-straddle-bot.ts        # Main bot logic
│   ├── index-straddle.ts          # Entry point with integrations
│   └── utils/
│       ├── state-manager.ts       # State persistence
│       ├── heartbeat-monitor.ts   # Health monitoring
│       └── mailgun-notification-service.ts # Notifications
├── logs/                          # Log files
├── data/                          # State files
├── run-bot-local.bat             # Auto-restart script
├── stop-bot.bat                  # Stop script
├── setup-task-scheduler.bat      # Task scheduler setup
├── task-scheduler-setup.xml      # Task scheduler config
└── .env                          # Configuration
```

This setup provides production-ready reliability with comprehensive monitoring and recovery capabilities for local operation.