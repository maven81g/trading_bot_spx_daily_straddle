@echo off
:: Setup Windows Task Scheduler for SPX Straddle Bot
:: Run this script as Administrator

echo Setting up Windows Task Scheduler for SPX Straddle Bot...
echo.

:: Delete existing task if it exists
schtasks /delete /tn "SPX_Straddle_Bot" /f 2>nul

:: Import the task from XML
schtasks /create /xml "task-scheduler-setup.xml" /tn "SPX_Straddle_Bot"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Task successfully created!
    echo.
    echo You can manage the task using:
    echo   - Start: schtasks /run /tn "SPX_Straddle_Bot"
    echo   - Stop:  schtasks /end /tn "SPX_Straddle_Bot"
    echo   - Status: schtasks /query /tn "SPX_Straddle_Bot"
    echo   - Delete: schtasks /delete /tn "SPX_Straddle_Bot" /f
    echo.
    echo Or use Task Scheduler GUI: taskschd.msc
) else (
    echo.
    echo Failed to create task. Make sure you're running as Administrator.
)

pause