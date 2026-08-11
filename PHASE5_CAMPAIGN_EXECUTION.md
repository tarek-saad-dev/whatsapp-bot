# Phase 5 — Campaign Execution

## Overview

Phase 5 implements the complete campaign execution flow:
1. **Start Campaign** - Queue messages for sending
2. **WhatsApp Worker** - Automatically process and send queued messages

## Task 7: Start Campaign Endpoint

### Endpoint

**POST** `/api/campaigns/offers/:id/start`

Starts a campaign by:
- Validating campaign exists
- Creating messages from audience (if not already created)
- Updating campaign status to `sending`
- Setting `startedAt` timestamp

### Request

```bash
POST /api/campaigns/offers/{campaignId}/start
```

### Response

**Success (200 OK):**
```json
{
  "success": true,
  "campaign": {
    "id": "campaign123",
    "offerId": "offer123",
    "status": "sending",
    "totalRecipients": 112,
    "sentCount": 0,
    "failedCount": 0,
    "startedAt": "2024-01-15T10:30:00.000Z"
  },
  "messages": {
    "total": 112,
    "pending": 112,
    "sent": 0,
    "failed": 0
  },
  "message": "Campaign started. Messages will be processed by the worker."
}
```

**Error Responses:**

**404 Not Found:**
```json
{
  "error": "Campaign not found",
  "message": "No campaign found with ID: campaign123"
}
```

**400 Bad Request (Already Started):**
```json
{
  "error": "Campaign already started",
  "message": "Campaign is already in status: sending"
}
```

### Behavior

1. **Validates campaign exists**
2. **Checks status** - Prevents starting already started/completed campaigns
3. **Creates messages if needed** - If no messages exist, creates them from audience
4. **Updates campaign status** - Sets status to `sending` and `startedAt` timestamp
5. **Returns message stats** - Shows current message status breakdown

## Task 8: WhatsApp Worker Integration

### Worker Service

**File:** `services/campaignWorker.js`

The worker automatically processes pending campaign messages and sends them via WhatsApp.

### Features

- **Automatic Processing** - Runs continuously, checking for pending messages every 5 seconds
- **Batch Processing** - Processes messages in configurable batches (default: 5 per batch)
- **Rate Limiting** - Respects delays between batches (default: 10 seconds)
- **Status Updates** - Updates message status (sent/failed) and campaign counters
- **Completion Detection** - Automatically marks campaigns as `completed` when all messages are processed

### Configuration

Environment variables (optional, defaults shown):

```env
CAMPAIGN_BATCH_SIZE=5              # Messages per batch
CAMPAIGN_MESSAGE_DELAY_MS=40000    # Delay between each message (40 seconds)
CAMPAIGN_BATCH_DELAY_MS=10000      # Delay between batches (10 seconds)
CAMPAIGN_POLL_INTERVAL_MS=5000     # How often to check for pending messages (5 seconds)
```

### Worker Flow

1. **Poll for Pending Messages**
   - Checks every 5 seconds (configurable)
   - Finds all messages with `status = 'pending'`

2. **Group by Campaign**
   - Groups messages by campaign for better tracking

3. **Process in Batches**
   - Processes messages in batches of 5 (configurable)
   - 40 second delay between individual messages (configurable via `CAMPAIGN_MESSAGE_DELAY_MS`)
   - 10 second delay between batches (configurable via `CAMPAIGN_BATCH_DELAY_MS`)

4. **Send via WhatsApp**
   - Uses `whatsappService.sendMessage(phone, messageBody)`
   - Handles success and failure cases

5. **Update Status**
   - **Success**: Sets message status to `sent`, updates `sentAt`, increments `campaign.sentCount`
   - **Failure**: Sets message status to `failed`, stores `errorMessage`, increments `campaign.failedCount`

6. **Check Completion**
   - After processing, checks if campaign has no pending messages
   - If complete, sets campaign status to `completed` and `completedAt` timestamp

### Worker Functions

#### `startWorker()`
Starts the automatic worker process. Called automatically when server starts.

#### `stopWorker()`
Stops the worker process.

#### `processPendingMessages()`
Main worker function that processes all pending messages.

#### `processCampaignMessages(campaignId)`
Manually process messages for a specific campaign.

### Integration

The worker is automatically started when the server starts:

```javascript
// In server.js
const campaignWorker = require('./services/campaignWorker');
campaignWorker.startWorker();
```

## Complete Flow

### 1. Create Offer
```bash
POST /api/offers
{ "name": "Summer Sale", "status": "draft" }
```

### 2. Add Targeting Rules
```bash
POST /api/offers/{offerId}/targeting
{ "cameFrom": "ميامي", "minVisits": 1 }
```

### 3. Build Audience
```bash
POST /api/offers/{offerId}/build-audience
```

### 4. Create Campaign
```bash
POST /api/campaigns
{ "offerId": "{offerId}" }
```

### 5. Start Campaign
```bash
POST /api/campaigns/offers/{campaignId}/start
```

### 6. Worker Processes Messages
- Worker automatically picks up pending messages
- Sends them via WhatsApp
- Updates status and counters
- Marks campaign as completed when done

### 7. Monitor Progress
```bash
GET /api/campaigns/offers/{campaignId}/stats
```

## API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/campaigns/offers/:id/start` | Start campaign (queue messages) |
| GET | `/api/campaigns/offers/:id` | Get campaign details with stats |
| GET | `/api/campaigns/offers/:id/messages` | Get campaign messages |
| GET | `/api/campaigns/offers/:id/stats` | Get campaign statistics |
| GET | `/api/campaigns/offers/:id/messages?status=pending` | Get pending messages |

## Message Status Flow

```
pending → sent (success)
       → failed (error)
```

## Campaign Status Flow

```
draft → sending → completed
```

## Error Handling

- **WhatsApp Service Errors**: Caught and stored in `errorMessage` field
- **Network Errors**: Messages marked as `failed` with error details
- **Rate Limiting**: Handled by batch delays and sequential processing
- **Worker Errors**: Logged but don't stop the worker

## Monitoring

### Check Worker Status

The worker logs all activity:
- `📬 Found X pending message(s)` - When messages are found
- `🔄 Processing batch of X messages...` - When processing starts
- `✅ Message X sent successfully` - When message succeeds
- `❌ Message X failed: error` - When message fails
- `✅ Campaign X completed` - When campaign finishes

### Check Campaign Progress

```bash
GET /api/campaigns/offers/{campaignId}/stats
```

Returns:
- Total recipients
- Sent count
- Failed count
- Message breakdown (pending/sent/failed)

## Testing

### Manual Test Flow

1. Create a campaign with 0 recipients (for testing)
2. Start the campaign: `POST /api/campaigns/offers/{id}/start`
3. Check stats: `GET /api/campaigns/offers/{id}/stats`
4. Monitor server logs for worker activity
5. Verify messages are being processed

### Test Script

Create a test script to verify the complete flow:

```javascript
// 1. Create campaign
const campaign = await createCampaign(offerId);

// 2. Start campaign
await startCampaign(campaign.id);

// 3. Wait and check progress
setInterval(async () => {
  const stats = await getCampaignStats(campaign.id);
  console.log(`Progress: ${stats.sent}/${stats.total} sent`);
  
  if (stats.campaign.status === 'completed') {
    console.log('Campaign completed!');
    process.exit(0);
  }
}, 5000);
```

## Notes

- **Worker runs automatically** - No manual intervention needed
- **Messages are queued** - Created when campaign is created or started
- **Rate limiting** - Built-in delays prevent overwhelming WhatsApp
- **Resilient** - Worker continues even if individual messages fail
- **Trackable** - Full audit trail of all message attempts


