@echo off
setlocal enabledelayedexpansion

echo ╔═══════════════════════════════════════════════════════════╗
echo ║                    LOG CLEANUP SCRIPT                     ║
echo ╚═══════════════════════════════════════════════════════════╝
echo.

set "LOGS_DIR=%~dp0logs"
set "BACKUP_DIR=%~dp0logs\backup_%date:~-4%%date:~-10,2%%date:~-7,2%"

if not exist "%LOGS_DIR%" (
    echo ❌ Logs directory not found: %LOGS_DIR%
    pause
    exit /b 1
)

echo 📂 Log directory: %LOGS_DIR%
echo 💾 Backup directory: %BACKUP_DIR%
echo.

:: Create backup directory
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

echo 🔍 Analyzing log files...
echo.

:: Count files to be cleaned
set /a OLD_COUNT=0
set /a DUPLICATE_COUNT=0

:: Check for old files (older than today)
for %%f in ("%LOGS_DIR%\bot_202508[25-28]*.log") do (
    if exist "%%f" set /a OLD_COUNT+=1
)
for %%f in ("%LOGS_DIR%\error-2025-08-[27-28].log") do (
    if exist "%%f" set /a OLD_COUNT+=1
)
for %%f in ("%LOGS_DIR%\straddle-bot-2025-08-27.log") do (
    if exist "%%f" set /a OLD_COUNT+=1
)

:: Check for duplicate/numbered files
for %%f in ("%LOGS_DIR%\error.log" "%LOGS_DIR%\error1.log" "%LOGS_DIR%\error2.log" "%LOGS_DIR%\error3.log") do (
    if exist "%%f" set /a DUPLICATE_COUNT+=1
)
for %%f in ("%LOGS_DIR%\straddle-bot.log" "%LOGS_DIR%\straddle-bot1.log" "%LOGS_DIR%\straddle-bot2.log" "%LOGS_DIR%\straddle-bot3.log") do (
    if exist "%%f" set /a DUPLICATE_COUNT+=1
)

echo 📊 CLEANUP SUMMARY:
echo    Old files (2+ days): %OLD_COUNT%
echo    Duplicate files: %DUPLICATE_COUNT%
echo    Total to clean: %OLD_COUNT% + %DUPLICATE_COUNT% = %expr %OLD_COUNT% + %DUPLICATE_COUNT%
echo.

:: Ask for confirmation
choice /C YN /M "Do you want to proceed with cleanup? (Y/N)"
if errorlevel 2 (
    echo ❌ Cleanup cancelled by user
    pause
    exit /b 0
)

echo.
echo 🗑️  Starting cleanup...
echo.

:: Move old files to backup
echo ├─ Moving old files to backup...
for %%f in ("%LOGS_DIR%\bot_202508[25-28]*.log") do (
    if exist "%%f" (
        echo │  📦 %%~nxf
        move "%%f" "%BACKUP_DIR%\" >nul 2>&1
    )
)

for %%f in ("%LOGS_DIR%\error-2025-08-[27-28].log") do (
    if exist "%%f" (
        echo │  📦 %%~nxf  
        move "%%f" "%BACKUP_DIR%\" >nul 2>&1
    )
)

if exist "%LOGS_DIR%\straddle-bot-2025-08-27.log" (
    echo │  📦 straddle-bot-2025-08-27.log
    move "%LOGS_DIR%\straddle-bot-2025-08-27.log" "%BACKUP_DIR%\" >nul 2>&1
)

:: Delete duplicate/numbered files  
echo ├─ Deleting duplicate files...
for %%f in ("%LOGS_DIR%\error.log" "%LOGS_DIR%\error1.log" "%LOGS_DIR%\error2.log" "%LOGS_DIR%\error3.log") do (
    if exist "%%f" (
        echo │  🗑️  %%~nxf
        del "%%f" >nul 2>&1
    )
)

for %%f in ("%LOGS_DIR%\straddle-bot.log" "%LOGS_DIR%\straddle-bot1.log" "%LOGS_DIR%\straddle-bot2.log" "%LOGS_DIR%\straddle-bot3.log") do (
    if exist "%%f" (
        echo │  🗑️  %%~nxf
        del "%%f" >nul 2>&1
    )
)

echo └─ Done!
echo.

echo ✅ CLEANUP COMPLETED!
echo.
echo 📋 REMAINING FILES:
dir /b "%LOGS_DIR%\*.log" 2>nul | findstr /v "backup" | sort

echo.
echo 💾 Backed up files are in: %BACKUP_DIR%
echo.

pause