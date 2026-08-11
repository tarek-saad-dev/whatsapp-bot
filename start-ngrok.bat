@echo off
title ngrok Tunnel [port 4000]
color 0E
echo ============================================
echo   ngrok Tunnel - port 4000
echo   Google Calendar webhooks require this
echo ============================================
echo.
echo Starting ngrok http 4000 ...
echo.
"C:\Users\user\Downloads\ngrok-v3-stable-windows-amd64\ngrok.exe" http 4000
echo.
echo [ngrok] Tunnel has stopped.
pause
