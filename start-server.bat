@echo off
title WhatsApp Bot Server
color 0A

echo ========================================
echo   WhatsApp Bot Server Launcher
echo ========================================
echo.

cd /d "%~dp0"

echo Checking Node.js installation...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js found!
echo.

echo Checking if node_modules exists...
if not exist "node_modules" (
    echo node_modules not found. Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
    echo.
)

echo Starting WhatsApp Bot Server...
echo.
echo Server will be available at: http://localhost:3000
echo.
echo Press Ctrl+C to stop the server
echo.

node server.js

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Server failed to start
    pause
)



