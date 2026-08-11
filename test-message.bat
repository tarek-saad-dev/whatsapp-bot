@echo off
title WhatsApp Bot - Test Message
color 0B

echo ========================================
echo   WhatsApp Bot - Test Message Sender
echo ========================================
echo.

cd /d "%~dp0"

echo Checking if server is running...
curl -s http://localhost:3000/api/health >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo WARNING: Server doesn't appear to be running!
    echo Please start the server first using: start-server.bat
    echo.
    pause
    exit /b 1
)

echo Server is running!
echo.

echo Running test message...
echo.

node test-specific-number.js

echo.
echo Test completed!
pause



