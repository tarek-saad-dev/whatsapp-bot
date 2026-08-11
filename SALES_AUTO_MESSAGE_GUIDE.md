# Auto WhatsApp Message on New Sale - Setup Guide

## Overview

This feature automatically sends WhatsApp messages to customers when a new sale is inserted into your SQL Server database. The flow is:

**SQL Server Trigger → HTTP POST → Node.js Endpoint → WhatsApp Web**

## Architecture

```
SQL Server Database
    ↓ (INSERT trigger fires)
SQL Server Trigger
    ↓ (HTTP POST request)
Node.js API Endpoint (/api/sales/notify)
    ↓ (Selenium automation)
WhatsApp Web
    ↓
Customer receives message
```

## Setup Instructions

### 1. Configure Environment Variables

Add to your `.env` file:

```env
# API Security Token (MUST CHANGE THIS!)
SQL_TRIGGER_TOKEN=your-secret-token-change-this-to-something-secure

# WhatsApp Bot Settings (already configured)
KEEP_LOGIN=true
USE_DEFAULT_CHROME=true
DEFAULT_DELAY_MS=3000
MIN_DELAY_MS=1000
MAX_DELAY_MS=2000
```

**⚠️ IMPORTANT:** Change `SQL_TRIGGER_TOKEN` to a secure random string!

### 2. Start the Node.js Server

```bash
npm start
```

The server will start on `http://localhost:3000` (or your configured PORT).

### 3. Initialize WhatsApp Connection

On first run, you'll need to scan the QR code:
- A Chrome window will open with WhatsApp Web
- Scan the QR code with your phone
- The connection will persist for future messages

### 4. Configure SQL Server Trigger

#### Option A: Using OLE Automation (Recommended if enabled)

1. Enable OLE Automation Procedures:
   ```sql
   EXEC sp_configure 'show advanced options', 1;
   RECONFIGURE;
   EXEC sp_configure 'Ole Automation Procedures', 1;
   RECONFIGURE;
   ```

2. Update the trigger in `sql/trigger_whatsapp_notification.sql`:
   - Change `@NodeJSEndpoint` to your server URL (if not localhost)
   - Change `@APIToken` to match your `SQL_TRIGGER_TOKEN` from `.env`
   - Adjust the table/column names to match your schema

3. Run the trigger script in SQL Server Management Studio

#### Option B: Using PowerShell (If OLE Automation is disabled)

1. Enable `xp_cmdshell`:
   ```sql
   EXEC sp_configure 'xp_cmdshell', 1;
   RECONFIGURE;
   ```

2. Use the PowerShell alternative in the trigger script

### 5. Test the Integration

#### Test via API directly:

```bash
curl -X POST http://localhost:3000/api/sales/notify \
  -H "Content-Type: application/json" \
  -H "X-API-Token: your-secret-token-change-this" \
  -d '{
    "phone": "201234567890",
    "saleData": {
      "orderId": "12345",
      "amount": "150.00",
      "currency": "EGP",
      "customerName": "John Doe",
      "date": "2024-01-15 10:30:00",
      "paymentMethod": "Cash",
      "items": "2"
    }
  }'
```

#### Test via SQL Insert:

```sql
INSERT INTO Sales (CustomerPhone, CustomerName, Amount, Currency, PaymentMethod, ItemCount)
VALUES ('201234567890', 'John Doe', 150.00, 'EGP', 'Cash', 2);
```

## API Endpoints

### POST /api/sales/notify

Sends a WhatsApp message for a new sale.

**Headers:**
- `X-API-Token`: Your secret token (required)
- `Content-Type`: application/json

**Request Body:**
```json
{
  "phone": "201234567890",
  "message": "Optional custom message (overrides template)",
  "saleData": {
    "orderId": "12345",
    "amount": "150.00",
    "currency": "EGP",
    "customerName": "John Doe",
    "date": "2024-01-15 10:30:00",
    "paymentMethod": "Cash",
    "items": "2"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "WhatsApp message sent successfully",
  "phone": "201234567890",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### GET /api/sales/status

Check if WhatsApp service is ready.

**Headers:**
- `X-API-Token`: Your secret token (required)

**Response:**
```json
{
  "success": true,
  "ready": true,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### POST /api/sales/reinitialize

Reinitialize WhatsApp connection if it's lost.

**Headers:**
- `X-API-Token`: Your secret token (required)

## Message Templates

The system uses a default template that can be customized. Template variables:

- `{{orderId}}` - Order/Sale ID
- `{{amount}}` - Sale amount
- `{{currency}}` - Currency code
- `{{date}}` - Sale date
- `{{customerName}}` - Customer name
- `{{phone}}` - Customer phone
- `{{items}}` - Number of items
- `{{paymentMethod}}` - Payment method

**Default Template:**
```
🎉 Thank you for your purchase!

Order #{{orderId}}
Amount: {{amount}} {{currency}}
Date: {{date}}

We appreciate your business! 🙏
```

## Customizing the Message

### Option 1: Custom message in API call

```json
{
  "phone": "201234567890",
  "message": "Your custom message here",
  "saleData": { ... }
}
```

### Option 2: Modify default template

Edit `routes/sales.js` and change the default template in the `formatMessage` function.

## Troubleshooting

### WhatsApp not connecting

1. Check if Chrome window opened
2. Scan QR code if prompted
3. Check server logs for errors
4. Try reinitializing: `POST /api/sales/reinitialize`

### SQL Trigger not firing

1. Verify trigger is created: `SELECT * FROM sys.triggers WHERE name = 'trg_Sales_WhatsAppNotification'`
2. Check SQL Server error logs
3. Test OLE Automation: `EXEC sp_OACreate 'MSXML2.ServerXMLHTTP', @obj OUT;`
4. Verify network connectivity from SQL Server to Node.js server

### Messages not sending

1. Check API token matches in both SQL trigger and `.env`
2. Verify phone number format (should be digits only, country code included)
3. Check Node.js server logs
4. Test API endpoint directly with curl/Postman

### Chrome crashes

1. Close all Chrome windows
2. Kill Chrome processes: `taskkill /F /IM chrome.exe` (Windows)
3. Restart Node.js server
4. Check Chrome profile directory permissions

## Security Considerations

1. **Change the API token** - Use a strong, random token
2. **Use HTTPS in production** - Don't send tokens over HTTP
3. **Restrict network access** - Only allow SQL Server to access the endpoint
4. **Rate limiting** - Consider adding rate limiting to prevent abuse
5. **Input validation** - SQL trigger should validate data before sending

## Production Deployment

1. **Use a process manager** (PM2, forever, etc.):
   ```bash
   npm install -g pm2
   pm2 start server.js --name whatsapp-bot
   pm2 save
   pm2 startup
   ```

2. **Set up as Windows Service** (if on Windows):
   - Use `node-windows` or `nssm` to run as service

3. **Configure firewall**:
   - Allow SQL Server to access Node.js server port
   - Restrict external access to API endpoints

4. **Monitor and log**:
   - Set up logging for all API calls
   - Monitor WhatsApp connection status
   - Alert on failures

## Database Schema Example

```sql
CREATE TABLE Sales (
    SaleID INT PRIMARY KEY IDENTITY(1,1),
    CustomerPhone NVARCHAR(20) NOT NULL,
    CustomerName NVARCHAR(100),
    Amount DECIMAL(10,2) NOT NULL,
    Currency NVARCHAR(10) DEFAULT 'EGP',
    SaleDate DATETIME DEFAULT GETDATE(),
    PaymentMethod NVARCHAR(50),
    ItemCount INT,
    Status NVARCHAR(20) DEFAULT 'Completed',
    WhatsAppSent BIT DEFAULT 0,
    WhatsAppSentDate DATETIME NULL
);
```

## Support

For issues or questions:
1. Check server logs
2. Test API endpoint directly
3. Verify SQL trigger syntax
4. Check network connectivity

