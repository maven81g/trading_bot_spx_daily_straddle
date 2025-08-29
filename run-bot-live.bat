@echo off
setlocal enabledelayedexpansion

:: SPX Straddle Bot with Live Console Output
:: Shows logs in real-time in console while also saving to file

set "BOT_DIR=C:\Development\GenAI Projects\trading_bot_spx_daily_straddle"
set "LOG_DIR=%BOT_DIR%\logs"
set "NODE_ENV=production"

:: Create logs directory if it doesn't exist
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Set log file with timestamp
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set datetime=%%I
set "YEAR=%datetime:~0,4%"
set "MONTH=%datetime:~4,2%"
set "DAY=%datetime:~6,2%"
set "LOG_FILE=%LOG_DIR%\bot_%YEAR%%MONTH%%DAY%.log"

echo ======================================
echo SPX Straddle Bot - Live Mode
echo Log File: %LOG_FILE%
echo Press Ctrl+C to stop
echo ======================================

cd /d "%BOT_DIR%"

:: Use PowerShell to tee output (show in console AND save to file)
powershell -Command "& {npm run start | Tee-Object -FilePath '%LOG_FILE%' -Append}"

echo.
echo Bot stopped at %date% %time%
pause