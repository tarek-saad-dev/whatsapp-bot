# Running Instructions - Chrome UI Requirements

## ⚠️ Important: Chrome UI Display Requirements

**Chrome requires an interactive Windows session to display the browser window.**

If Chrome doesn't open when the server starts, it's because Node.js is running in a non-interactive session without GUI permissions.

## ✅ Correct Way to Run

### Option 1: Direct Node Execution (Recommended)
```bash
# Run directly with node (interactive session)
node server.js
```

### Option 2: PowerShell/CMD (Interactive)
```bash
# Open PowerShell or CMD as regular user (not as service)
cd H:\whatsapp-bot-node
node server.js
```

### Option 3: NPM Script (if configured correctly)
```bash
npm start
```

## ❌ What NOT to Do

- **Don't run as Windows Service** (no GUI access)
- **Don't run in background without GUI** (npm start in some terminals)
- **Don't run via task scheduler** without "Run only when user is logged on"
- **Don't run via SSH** (no desktop session)

## 🔍 How to Check

If Chrome doesn't open, check:

1. **Is Node running interactively?**
   ```bash
   # In PowerShell, check if you can see the window
   Get-Process node | Select-Object Id, ProcessName, MainWindowTitle
   ```

2. **Check session type:**
   ```bash
   echo $env:SESSIONNAME
   # Should show "Console" not empty
   ```

3. **Test Chrome manually:**
   ```bash
   # If Chrome opens manually, the issue is session-related
   start chrome.exe
   ```

## 🛠️ Troubleshooting

### Chrome Still Doesn't Open

1. **Kill all Chrome processes:**
   ```bash
   taskkill /F /IM chrome.exe /T
   taskkill /F /IM chromedriver.exe /T
   ```

2. **Clean profile directory:**
   ```bash
   # Via API
   curl -X POST http://localhost:3000/api/sales/cleanup \
     -H "X-API-Token: your-secret-token"
   ```

3. **Run server in foreground:**
   - Open PowerShell/CMD window
   - Navigate to project directory
   - Run: `node server.js`
   - Keep the window open

4. **Check Windows session:**
   - Make sure you're logged in to Windows
   - Don't use RDP in console mode
   - Use local session or RDP with GUI

## 📝 Production Deployment

For production, you have options:

### Option A: Keep Interactive Session
- Run server as a logged-in user
- Use a tool like `pm2` with GUI support
- Or use Windows Task Scheduler with "Run only when user is logged on"

### Option B: Use Headless Mode (Future)
- Modify to use `--headless` flag
- But WhatsApp Web requires GUI for QR code scanning
- Not recommended for WhatsApp automation

### Option C: Run on Dedicated Machine
- Use a dedicated Windows machine/VM
- Keep user logged in
- Run server as that user

## ✅ Verification

After starting the server, you should see:
1. Chrome window opens automatically
2. WhatsApp Web loads
3. QR code appears (if not logged in)
4. Server logs show "WhatsApp Web is ready"

If Chrome doesn't open, the server is running in a non-interactive session.

