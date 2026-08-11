@echo off
title Hawai Launcher
color 0A

echo ============================================================
echo            Hawai Apps Launcher
echo ============================================================
echo.

rem ---- Check Node.js ----
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download from https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js found: %NODE_VER%
echo.

rem ---- Check WhatsApp Bot project ----
echo --- WhatsApp Bot Server ---

if not exist "H:\whatsapp-bot-node\package.json" (
    color 0C
    echo [ERROR] package.json not found in H:\whatsapp-bot-node
    pause
    exit /b 1
)
echo [OK] H:\whatsapp-bot-node\package.json found

if not exist "H:\whatsapp-bot-node\node_modules\" (
    echo [WARN] node_modules missing - running npm install...
    pushd "H:\whatsapp-bot-node"
    call npm install
    popd
    if errorlevel 1 (
        color 0C
        echo [ERROR] npm install failed for WhatsApp Bot
        pause
        exit /b 1
    )
    echo [OK] npm install completed
) else (
    echo [OK] node_modules exists
)
echo.

rem ---- Check Google Calendar Sync project ----
echo --- Google Calendar Sync Server ---

if not exist "H:\whatsapp-bot-node\google-calendar-sync\package.json" (
    color 0C
    echo [ERROR] package.json not found in H:\whatsapp-bot-node\google-calendar-sync
    pause
    exit /b 1
)
echo [OK] H:\whatsapp-bot-node\google-calendar-sync\package.json found

if not exist "H:\whatsapp-bot-node\google-calendar-sync\node_modules\" (
    echo [WARN] node_modules missing - running npm install...
    pushd "H:\whatsapp-bot-node\google-calendar-sync"
    call npm install
    popd
    if errorlevel 1 (
        color 0C
        echo [ERROR] npm install failed for Google Calendar Sync
        pause
        exit /b 1
    )
    echo [OK] npm install completed
) else (
    echo [OK] node_modules exists
)
echo.

rem ---- Check ngrok ----
echo --- ngrok Tunnel ---

if not exist "C:\Users\user\Downloads\ngrok-v3-stable-windows-amd64\ngrok.exe" (
    color 0C
    echo [ERROR] ngrok.exe not found at:
    echo         C:\Users\user\Downloads\ngrok-v3-stable-windows-amd64\ngrok.exe
    echo         Google Calendar webhooks will NOT work without ngrok.
    pause
    exit /b 1
)
echo [OK] ngrok.exe found
echo.

rem ---- Free port 3000 ----
echo --- Checking port 3000 ---
set FOUND3000=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000 "') do (
    if not "%%p"=="0" (
        echo  Killing PID %%p on port 3000...
        taskkill /F /PID %%p >nul 2>&1
        set FOUND3000=1
    )
)
if "%FOUND3000%"=="0" echo  Port 3000 is free
echo.

rem ---- Free port 4000 ----
echo --- Checking port 4000 ---
set FOUND4000=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":4000 "') do (
    if not "%%p"=="0" (
        echo  Killing PID %%p on port 4000...
        taskkill /F /PID %%p >nul 2>&1
        set FOUND4000=1
    )
)
if "%FOUND4000%"=="0" echo  Port 4000 is free
echo.

rem ---- Check POS System project ----
echo --- POS System (Next.js) ---

if not exist "H:\whatsapp-bot-node\pos-system\package.json" (
    color 0C
    echo [ERROR] package.json not found in H:\whatsapp-bot-node\pos-system
    pause
    exit /b 1
)
echo [OK] H:\whatsapp-bot-node\pos-system\package.json found

if not exist "H:\whatsapp-bot-node\pos-system\node_modules\" (
    echo [WARN] node_modules missing - running npm install...
    pushd "H:\whatsapp-bot-node\pos-system"
    call npm install
    popd
    if errorlevel 1 (
        color 0C
        echo [ERROR] npm install failed for POS System
        pause
        exit /b 1
    )
    echo [OK] npm install completed
) else (
    echo [OK] node_modules exists
)
echo.

echo  Waiting for ports to fully release...
timeout /t 3 /nobreak >nul

rem ---- Launch all services ----
echo ============================================================
echo  Launching all services...
echo ============================================================
echo.

echo  [1] WhatsApp Bot Server       - http://localhost:3000
start "WhatsApp Bot Server" "H:\whatsapp-bot-node\start-whatsapp.bat"

echo  Waiting for WhatsApp Bot to initialize...
timeout /t 4 /nobreak >nul

echo  [2] Google Calendar Sync      - http://localhost:4000
start "Google Calendar Sync Server" "H:\whatsapp-bot-node\start-calendar.bat"

echo  Waiting for Calendar Sync to initialize...
timeout /t 4 /nobreak >nul

echo  [3] POS System (Cut Salon)    - http://localhost:3000
start "POS System - Cut Salon" cmd /k "cd /d H:\whatsapp-bot-node\pos-system && npm run dev"

echo  Waiting for POS System to initialize...
timeout /t 5 /nobreak >nul

rem ---- Kill old ngrok before starting fresh ----
echo --- Stopping old ngrok (if any) ---
echo  (ngrok must not run twice with the same endpoint)
taskkill /F /IM ngrok.exe >nul 2>&1
if %errorlevel% equ 0 (
    echo  Old ngrok.exe killed
    timeout /t 2 /nobreak >nul
) else (
    echo  No old ngrok running
)
echo.

echo  [4] ngrok Tunnel              - http://localhost:4000
start "ngrok Tunnel" "H:\whatsapp-bot-node\start-ngrok.bat"

echo.
echo ============================================================
echo  All 4 services are launching in separate windows.
echo.
echo  WhatsApp Bot:          http://localhost:3000
echo  Google Calendar Sync:  http://localhost:4000
echo  POS System:            http://localhost:3000 (Cut Salon)
echo  ngrok Tunnel:          forwarding to port 4000
echo.
echo  NOTE: Google Calendar webhooks require ngrok to stay open.
echo        Copy the ngrok HTTPS URL into your .env as WEBHOOK_URL.
echo.
echo  Close this window or press any key to exit the launcher.
echo ============================================================
echo.
pause
