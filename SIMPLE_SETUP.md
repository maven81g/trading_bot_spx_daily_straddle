# SPX Trading Bot - Ultra Simple Setup

The trading bot is now **completely simplified** with only ONE configuration approach.

## 🚀 Quick Start (3 Steps)

1. **Copy environment file:**
   ```bash
   copy env.example .env
   ```

2. **Fill in your TradeStation credentials in `.env`:**
   ```
   TRADESTATION_CLIENT_ID=your_client_id_here
   TRADESTATION_CLIENT_SECRET=your_client_secret_here  
   TRADESTATION_REFRESH_TOKEN=your_refresh_token_here
   ```

3. **Start the bot:**
   ```bash
   npm start
   ```

## 📊 Commands

- **`npm start`** - Start the trading bot (**MAIN COMMAND**)
- **`npm run test-spx`** - Test the SPX strategy
- **`npm run start:prod`** - Production build mode

## ⚙️ Configuration 

**ALL configuration is in ONE place**: `src/index.ts` lines 30-70

No complex config files, no JSON loading, just simple direct configuration:

```typescript
const config: BotConfig = {
  strategies: [
    {
      id: 'spx-backtest-strategy',
      enabled: true,  // ← Strategy enabled here
      parameters: {
        macdThreshold: -1.0,  // ← Settings here
        profitTarget: 1.0
      }
    }
  ]
}
```

## 🔧 What Was Eliminated

- ❌ `src/utils/config.ts` (complex config loader)
- ❌ `config/strategies.json` (external strategy file) 
- ❌ `start-bot.ts` (duplicate startup script)
- ❌ `src/index-simple.ts` (confusing duplicate file)
- ❌ Complex validation and environment handling
- ❌ Multiple configuration sources
- ❌ Multiple README files

## ✅ What Remains

- ✅ **ONE** simple configuration in `src/index.ts`
- ✅ **ONE** startup command: `npm start`
- ✅ **ONE** strategy: SPX Backtest (proven logic)
- ✅ Refresh token authentication (like backtest)
- ✅ Environment variables for credentials only

## 📈 Strategy Configuration

The SPX strategy is **hard-coded with proven parameters**:

```typescript
{
  macdFastPeriod: 12,
  macdSlowPeriod: 26, 
  macdSignalPeriod: 9,
  macdThreshold: -1.0,      // ← From successful backtest
  profitTarget: 1.0,        // ← $1 profit target
  stopLossPercentage: 0.20  // ← 20% stop loss
}
```

## 🛡️ Safety

- **Paper Trading**: Enabled by default
- **Single Strategy**: Only SPX backtest strategy runs
- **No Complex Config**: Can't accidentally enable wrong strategies
- **Simple Environment**: Just 3 required variables

## 🎯 Files That Matter

- **`src/index.ts`** - Main bot with embedded configuration
- **`src/strategies/spx-backtest-strategy.ts`** - Strategy logic
- **`src/api/client.ts`** - Simple API client
- **`.env`** - Your credentials only

**Everything else is just supporting infrastructure.**

## 🚀 Ultra Simple

Now there's **only ONE way** to configure and run the bot. No confusion, no multiple options, just:

1. Set your credentials
2. Run `npm start` 
3. Bot starts with proven SPX strategy

**That's it!**