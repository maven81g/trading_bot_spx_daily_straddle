@echo off
:: Stop SPX Straddle Bot Script

echo Stopping SPX Straddle Bot...

:: Kill Node.js processes running the bot
taskkill /F /IM node.exe /FI "WINDOWTITLE eq *spx-straddle*" 2>nul
taskkill /F /IM node.exe /FI "COMMANDLINE eq *index-straddle*" 2>nul

:: Also try to kill by window title
taskkill /F /FI "WINDOWTITLE eq *run-bot-local*" 2>nul

echo Bot stopped.
pause