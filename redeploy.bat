@echo off
REM Quick redeploy script for trading bot
REM Use this when you've made code changes and secrets already exist

echo =====================================
echo Trading Bot - Quick Redeploy
echo =====================================

REM Check if environment variables are set
if "%GOOGLE_CLOUD_PROJECT%"=="" (
    echo ERROR: GOOGLE_CLOUD_PROJECT not set
    echo Run: set GOOGLE_CLOUD_PROJECT=your-project-id
    pause
    exit /b 1
)

echo Project: %GOOGLE_CLOUD_PROJECT%
echo.

REM Navigate to cloud-run-service directory
cd cloud-run-service

REM Run deployment
echo Deploying to Cloud Run...
call deploy.sh

echo.
echo =====================================
echo Redeploy Complete!
echo =====================================
echo.
echo Next: Check your Cloud Scheduler job is still configured in Google Console
echo Service will start automatically at 9:30 AM via scheduler
echo.

pause