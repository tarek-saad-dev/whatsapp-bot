@echo off
title Google Calendar Sync Server [localhost:4000]
color 0D
echo ============================================
echo   Google Calendar Sync Server
echo   http://localhost:4000
echo ============================================
echo.
cd /d "H:\whatsapp-bot-node\google-calendar-sync"
if errorlevel 1 (
    echo [ERROR] Could not cd into H:\whatsapp-bot-node\google-calendar-sync
    pause
    exit /b 1
)
echo Starting Google Calendar Sync Server...
echo.
node server.js
echo.
echo [Calendar Sync] Server has stopped.
pause
