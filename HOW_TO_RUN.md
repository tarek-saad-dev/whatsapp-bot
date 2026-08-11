# How to Run WhatsApp Bot

Step-by-step guide for anyone setting up this project on Windows.

---

## Requirements

1. **Windows** (Chrome UI must open — do not run as a background Windows service)
2. **Node.js 18+** — https://nodejs.org/
3. **Google Chrome** installed
4. **SQL Server** access (for offers, audience, and sales features)
5. A phone with **WhatsApp** to scan the QR code on first login

---

## Step 1 — Get the project

Copy or clone the project folder to your PC, for example:

```text
C:\Users\YOUR_USER\Desktop\whatsapp-bot-clean
```

---

## Step 2 — Install dependencies

Open **PowerShell** or **CMD** in the project folder:

```bat
cd C:\Users\YOUR_USER\Desktop\whatsapp-bot-clean
npm install
```

Wait until install finishes with no errors.

---

## Step 3 — Create your `.env` file

1. Copy the example file:

```bat
copy .env.example .env
```

2. Open `.env` in Notepad and edit these values for **your** machine:

| Variable | What to put |
|----------|-------------|
| `WHATSAPP_CHROME_PROFILE_DIR` | Full path to a **new empty folder** for the bot Chrome profile (example below) |
| `SQL_TRIGGER_TOKEN` | Any long secret string (used to protect the notify API) |
| `DB_SERVER` | Your SQL Server name or IP |
| `DB_NAME` | Your database name |
| `DB_USER` / `DB_PASSWORD` | SQL login |
| `SMS_HUB_API_KEY` | Your SMS API key (if you use SMS) |
| `SMS_HUB_SENDER_NAME` | Approved sender name |

Example Chrome profile path:

```env
WHATSAPP_CHROME_PROFILE_DIR=C:\\Users\\YOUR_USER\\Desktop\\whatsapp-bot-clean\\chrome-profile-automessage
```

Notes:

- Use **double backslashes** `\\` in paths inside `.env`
- Do **not** point the profile at your everyday Chrome user folder
- Keep `.env` private — never commit it to git

---

## Step 4 — Start the server

### Easiest way

Double-click:

```text
start-server.bat
```

### Or from terminal

```bat
npm start
```

You should see something like:

```text
Campaign Management Server running on http://localhost:3000
```

Leave this window **open** while the bot is running.

---

## Step 5 — Open the web UI

In your browser go to:

```text
http://localhost:3000
```

---

## Step 6 — Login to WhatsApp Web (first time)

1. When the bot needs WhatsApp, Chrome opens WhatsApp Web
2. Scan the **QR code** with your phone (WhatsApp → Linked Devices)
3. With `KEEP_LOGIN=true`, the next starts usually stay logged in (same Chrome profile folder)

Important:

- Run on a normal logged-in Windows desktop
- Do **not** run as a Windows Service (Chrome will not show)

---

## Step 7 — Quick health check

Open:

```text
http://localhost:3000/api/health
```

You should get JSON like:

```json
{ "status": "ok", "timestamp": "..." }
```

---

## Useful endpoints

| Purpose | URL |
|---------|-----|
| Web dashboard | http://localhost:3000 |
| Health check | http://localhost:3000/api/health |
| Sales auto-notify | http://localhost:3000/api/sales/notify |
| Send WhatsApp message | http://localhost:3000/api/whatsapp/send |

For sales notify, send header:

```text
X-API-Token: <same value as SQL_TRIGGER_TOKEN in .env>
```

---

## Optional: Excel contacts

If you use Excel sending:

1. Put `contacts.xlsx` in the project root
2. Sheet name must match `EXCEL_SHEET` (default `BOT`)

---

## Optional: Campaign auto-worker

By default campaigns are **not** auto-processed.

To enable automatic campaign sending, set in `.env`:

```env
ENABLE_CAMPAIGN_WORKER=true
```

Then restart the server.

---

## Stop the server

In the server window press `Ctrl + C`.

---

## Common problems

| Problem | Fix |
|---------|-----|
| `Node.js is not installed` | Install from https://nodejs.org/ and reopen the terminal |
| Chrome does not open | Run with `start-server.bat` or `node server.js` in a normal desktop session |
| Port 3000 already in use | Close the other app, or change `PORT=3001` in `.env` |
| WhatsApp asks for QR again | Check `WHATSAPP_CHROME_PROFILE_DIR` path and that `KEEP_LOGIN=true` |
| Database errors | Verify SQL Server is running and `DB_*` values in `.env` |
| Stuck Chrome / chromedriver | Run `kill-bot-chrome.ps1` then start again |

---

## Security checklist before sharing the project

1. Share `.env.example`, **not** your real `.env`
2. Change `SQL_TRIGGER_TOKEN` from the default
3. Do not publish real `DB_PASSWORD` or `SMS_HUB_API_KEY`
4. Each person must create their own Chrome profile folder path
