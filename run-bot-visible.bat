@echo off
title SPX Straddle Bot - Live Output

:: SPX Straddle Bot with Visible Output
:: This version shows all output in the terminal window

set "BOT_DIR=C:\Development\GenAI Projects\trading_bot_spx_daily_straddle"
set "NODE_ENV=production"
set "LOG_LEVEL=warn"

echo.
echo ╔═══════════════════════════════════════════════════════════╗
echo ║                   SPX STRADDLE BOT                        ║
echo ║                    Live Output Mode                       ║
echo ╚═══════════════════════════════════════════════════════════╝
echo.
echo [%date% %time%] Starting bot...
echo Keep this window open to monitor the bot's activity.
echo Press Ctrl+C to stop the bot.
echo.

cd /d "%BOT_DIR%"

:START_BOT
echo ═════════════════════════════════════════════════════════════
echo [%date% %time%] Starting SPX Straddle Bot...
echo ═════════════════════════════════════════════════════════════

:: Run the bot with live output
npm run start

set EXIT_CODE=%ERRORLEVEL%

echo.
echo ═════════════════════════════════════════════════════════════
echo [%date% %time%] Bot stopped with exit code: %EXIT_CODE%
echo ═════════════════════════════════════════════════════════════

:: Check if running from Task Scheduler (no user interaction)
if "%SESSIONNAME%"=="" (
    echo Running from Task Scheduler - Bot stopped, will not restart automatically
    echo Check logs for details: %BOT_DIR%\logs\
    timeout /t 10
    goto END
)

:: Ask user if they want to restart (only when run interactively)
choice /C YN /M "Do you want to restart the bot? (Y/N)"
if errorlevel 2 goto END
if errorlevel 1 goto START_BOT

:END
echo.
echo Bot monitoring stopped.
if not "%SESSIONNAME%"=="" pause