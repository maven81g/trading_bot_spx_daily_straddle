@echo off
setlocal enabledelayedexpansion

:: SPX Straddle Bot Auto-Restart Script
:: This script runs the bot and automatically restarts it if it crashes
:: It also logs all output and restarts to a file

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

echo ====================================== >> "%LOG_FILE%"
echo Bot Monitoring Started: %date% %time% >> "%LOG_FILE%"
echo ====================================== >> "%LOG_FILE%"

:START_BOT
echo.
echo [%date% %time%] Starting SPX Straddle Bot...
echo [%date% %time%] Starting SPX Straddle Bot... >> "%LOG_FILE%"

cd /d "%BOT_DIR%"

:: Run the bot and capture exit code
npm run start 2>&1 | tee -a "%LOG_FILE%"
set EXIT_CODE=%ERRORLEVEL%

echo.
echo [%date% %time%] Bot exited with code: %EXIT_CODE%
echo [%date% %time%] Bot exited with code: %EXIT_CODE% >> "%LOG_FILE%"

:: Check if it's during market hours (9:30 AM - 4:00 PM ET, Mon-Fri)
for /f "tokens=1-3 delims=:. " %%a in ('echo %time%') do (
    set /a "hour=10%%a %% 100"
    set /a "min=10%%b %% 100"
)

for /f "tokens=1" %%a in ('wmic path win32_localtime get dayofweek /value ^| findstr "="') do (
    set "%%a"
)

:: DayOfWeek: 1=Monday, 5=Friday
if %DayOfWeek% GEQ 1 if %DayOfWeek% LEQ 5 (
    :: Check if between 9:30 AM and 4:00 PM ET (adjust for your timezone)
    if %hour% GEQ 9 if %hour% LEQ 16 (
        echo [%date% %time%] Market hours - Restarting in 30 seconds...
        echo [%date% %time%] Market hours - Restarting in 30 seconds... >> "%LOG_FILE%"
        timeout /t 30 /nobreak
    ) else (
        echo [%date% %time%] Outside market hours - Restarting in 5 minutes...
        echo [%date% %time%] Outside market hours - Restarting in 5 minutes... >> "%LOG_FILE%"
        timeout /t 300 /nobreak
    )
) else (
    echo [%date% %time%] Weekend - Restarting in 30 minutes...
    echo [%date% %time%] Weekend - Restarting in 30 minutes... >> "%LOG_FILE%"
    timeout /t 1800 /nobreak
)

goto START_BOT