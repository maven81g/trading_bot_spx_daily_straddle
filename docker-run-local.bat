@echo off
REM Simple Docker run script for local development

echo =====================================
echo Trading Bot - Local Docker Development
echo =====================================
echo.

REM Check if .env exists
if not exist ".env" (
    echo Creating .env from env.example...
    copy env.example .env
    echo Please edit .env with your credentials
    pause
    exit /b 1
)

REM Menu for different run options
echo Select run option:
echo [1] Run with docker-compose (recommended)
echo [2] Build and run with simple Docker
echo [3] Run SPX backtest
echo [4] Stop and clean up
echo.
set /p choice="Enter choice (1-4): "

if "%choice%"=="1" goto compose
if "%choice%"=="2" goto docker
if "%choice%"=="3" goto backtest
if "%choice%"=="4" goto cleanup

echo Invalid choice
pause
exit /b 1

:compose
echo.
echo Starting with docker-compose...
docker-compose up --build
goto end

:docker
echo.
echo Building Docker image...
docker build -f Dockerfile.dev -t trading-bot-dev .
echo.
echo Running container...
docker run -it --rm --name trading-bot-dev --env-file .env -v "%cd%\logs:/app/logs" trading-bot-dev
goto end

:backtest
echo.
echo Running SPX backtest...
docker-compose run --rm trading-bot npm run test-spx
goto end

:cleanup
echo.
echo Stopping and cleaning up...
docker-compose down
docker rm -f trading-bot-dev 2>nul
echo Cleanup complete
goto end

:end
echo.
echo =====================================
echo To view logs in real-time:
echo   docker logs -f trading-bot-local
echo   OR
echo   docker-compose logs -f
echo =====================================
pause