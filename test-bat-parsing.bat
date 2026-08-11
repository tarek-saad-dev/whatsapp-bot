@echo off
title BAT Parsing Test
echo ============================================
echo   BAT Parsing Diagnostic
echo ============================================
echo.
echo [TEST 1] Echo works: OK
echo [TEST 2] Node check...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [FAIL] Node.js not found in PATH
) else (
    for /f "tokens=*" %%v in ('node -v') do echo [OK] Node.js version: %%v
)
echo [TEST 3] Path check: H:\whatsapp-bot-node
if exist "H:\whatsapp-bot-node\package.json" (
    echo [OK] WhatsApp package.json found
) else (
    echo [FAIL] WhatsApp package.json NOT found
)
echo [TEST 4] Path check: H:\whatsapp-bot-node\google-calendar-sync
if exist "H:\whatsapp-bot-node\google-calendar-sync\package.json" (
    echo [OK] Calendar package.json found
) else (
    echo [FAIL] Calendar package.json NOT found
)
echo [TEST 5] Start command test...
echo   If you see a notepad window, start command works. Close notepad.
start "Test Window" notepad.exe
echo [OK] start command executed
echo.
echo All tests done. If all say OK, your CMD parsing is fine.
echo Close this window and run start-all.bat
echo.
pause
