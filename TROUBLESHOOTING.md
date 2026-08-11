# Troubleshooting Guide

## Chrome Not Opening / Messages Not Sending

### Issue: Chrome doesn't open when message is sent

**Symptoms:**
- Messages are queued but never sent
- Logs show "WhatsApp initialization already in progress..."
- Chrome window never appears

**Solutions:**

1. **Restart the server:**
   ```bash
   # Stop server (Ctrl+C)
   npm start
   ```

2. **Reset WhatsApp service:**
   ```bash
   curl -X POST http://localhost:3000/api/sales/reset \
     -H "X-API-Token: your-secret-token-change-this"
   ```

3. **Check Chrome installation:**
   - Make sure Google Chrome is installed
   - Check if Chrome path is correct in `.env` (if using custom path)

4. **Check for stuck processes:**
   ```bash
   # Windows
   tasklist | findstr chrome
   # Kill stuck Chrome processes
   taskkill /F /IM chrome.exe
   ```

5. **Check server logs:**
   - Look for error messages about Chrome driver
   - Check if initialization timeout occurred

### Issue: Messages queued but not sending

**Check queue status:**
```bash
curl -H "X-API-Token: your-secret-token" http://localhost:3000/api/sales/queue-status
```

**Manually trigger queue processing:**
```bash
curl -X POST http://localhost:3000/api/sales/process-queue \
  -H "X-API-Token: your-secret-token"
```

### Issue: WhatsApp QR code not appearing

1. **Check Chrome window** - It should open automatically
2. **Wait 10-15 seconds** - QR code may take time to load
3. **Check internet connection** - WhatsApp Web needs internet
4. **Try manual reset** - Use the reset endpoint above

### Common Error Messages

**"Error creating Chrome driver"**
- Chrome not installed
- Chrome path incorrect
- Chrome version incompatible with ChromeDriver

**"Initialization timeout"**
- Chrome took too long to start
- Network issues
- System resources low

**"WhatsApp Web is ready" but messages not sending**
- Check if QR code was scanned
- Verify WhatsApp Web is actually logged in
- Check server logs for send errors

## Quick Fixes

### Force Reset Everything
```bash
# 1. Stop server
# 2. Kill Chrome
taskkill /F /IM chrome.exe
# 3. Restart server
npm start
# 4. Send test message
node test-specific-number.js
```

### Check Status
```bash
# Queue status
curl -H "X-API-Token: your-token" http://localhost:3000/api/sales/queue-status

# WhatsApp status
curl -H "X-API-Token: your-token" http://localhost:3000/api/sales/status
```

## Still Not Working?

1. Check server logs for detailed error messages
2. Verify `.env` file has correct settings
3. Make sure port 3000 is not blocked
4. Check Windows Firewall settings
5. Try running as Administrator

