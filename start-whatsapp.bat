@echo off
title WhatsApp Bot Server [localhost:3000]
color 0B
echo ============================================
echo   WhatsApp Bot Server
echo   http://localhost:3000
echo ============================================
echo.
cd /d "H:\whatsapp-bot-node"
if errorlevel 1 (
    echo [ERROR] Could not cd into H:\whatsapp-bot-node
    pause
    exit /b 1
)
echo Starting WhatsApp Bot Server...
echo.
node server.js
echo.
echo [WhatsApp Bot] Server has stopped.
pause
