@echo off
title Remove Auto-Startup for Hawai Services
color 0E

echo ============================================================
echo     Remove Auto-Startup for Hawai Services
echo ============================================================
echo.

rem ---- Get startup folder path ----
set STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT_PATH=%STARTUP_FOLDER%\Hawai Auto-Start.lnk

echo [INFO] Checking for startup shortcut...
echo.

if exist "%SHORTCUT_PATH%" (
    echo [FOUND] Startup shortcut exists at:
    echo         %SHORTCUT_PATH%
    echo.
    echo Removing...
    del "%SHORTCUT_PATH%"
    
    if errorlevel 1 (
        color 0C
        echo [ERROR] Failed to delete shortcut
        pause
        exit /b 1
    )
    
    echo [OK] Auto-startup has been disabled!
    echo.
    echo Services will no longer start automatically on PC boot.
) else (
    echo [INFO] No auto-startup shortcut found.
    echo        Services are not configured to start automatically.
)

echo.
echo ============================================================
echo.
pause
