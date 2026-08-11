@echo off
title Setup Auto-Startup for Hawai Services
color 0B

echo ============================================================
echo     Setup Auto-Startup for Hawai Services
echo ============================================================
echo.
echo This script will configure Windows to automatically start
echo all Hawai services when your PC boots up.
echo.
echo The services will start with a 30-second delay to allow
echo Windows to fully initialize.
echo.
pause
echo.

rem ---- Get startup folder path ----
set STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

echo [INFO] Startup folder: %STARTUP_FOLDER%
echo.

rem ---- Check if VBS file exists ----
if not exist "H:\whatsapp-bot-node\start-all-delayed.vbs" (
    color 0C
    echo [ERROR] start-all-delayed.vbs not found!
    echo         Expected at: H:\whatsapp-bot-node\start-all-delayed.vbs
    pause
    exit /b 1
)

echo [OK] Found start-all-delayed.vbs
echo.

rem ---- Create shortcut in startup folder ----
echo [INFO] Creating startup shortcut...

powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%STARTUP_FOLDER%\Hawai Auto-Start.lnk'); $Shortcut.TargetPath = 'H:\whatsapp-bot-node\start-all-delayed.vbs'; $Shortcut.WorkingDirectory = 'H:\whatsapp-bot-node'; $Shortcut.Description = 'Auto-start Hawai services on PC startup'; $Shortcut.Save()"

if errorlevel 1 (
    color 0C
    echo [ERROR] Failed to create startup shortcut
    pause
    exit /b 1
)

echo [OK] Startup shortcut created successfully!
echo.
echo ============================================================
echo  Setup Complete!
echo ============================================================
echo.
echo  Location: %STARTUP_FOLDER%\Hawai Auto-Start.lnk
echo.
echo  What happens on next boot:
echo  1. Windows starts
echo  2. Wait 30 seconds (for system to stabilize)
echo  3. All Hawai services launch automatically:
echo     - WhatsApp Bot Server
echo     - Google Calendar Sync
echo     - POS System (Cut Salon)
echo     - ngrok Tunnel
echo.
echo  To disable auto-startup:
echo  - Delete the shortcut from the Startup folder
echo  - Or run: del "%STARTUP_FOLDER%\Hawai Auto-Start.lnk"
echo.
echo  To test now without rebooting:
echo  - Double-click: H:\whatsapp-bot-node\start-all-delayed.vbs
echo.
echo ============================================================
echo.
pause
