# Campaigns API Documentation

## Overview

This API supports two types of campaigns:
1. **Segment-based campaigns** (legacy) - Based on customer segments
2. **Offer-based campaigns** (new) - Based on offers with targeting rules

## Base URL

```
http://localhost:3000/api/campaigns
```

## Offer-Based Campaign Endpoints

### 1. Create Campaign from Offer

**POST** `/api/campaigns`

Creates a new campaign from an offer. This will:
- Validate the offer exists
- Get total recipients from OfferAudience
- Create campaign with status 'draft'
- Create campaign messages for each audience member

**Request Body:**
```json
{
  "offerId": "1763917725219kxleeexme"
}
```

**Response (201 Created):**
```json
{
  "id": "campaign123",
  "offerId": "1763917725219kxleeexme",
  "status": "draft",
  "totalRecipients": 112,
  "sentCount": 0,
  "failedCount": 0,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "messagesCreated": 112
}
```

**Error Responses:**

**404 Not Found:**
```json
{
  "error": "Offer not found",
  "message": "No offer found with ID: 1763917725219kxleeexme"
}
```

**400 Bad Request (No Audience):**
```json
{
  "error": "No audience found",
  "message": "Please build the audience for this offer first using POST /api/offers/:id/build-audience"
}
```

**Example using cURL:**
```bash
curl -X POST http://localhost:3000/api/campaigns \
  -H "Content-Type: application/json" \
  -d '{
    "offerId": "1763917725219kxleeexme"
  }'
```

### 2. Get All Offer-Based Campaigns

**GET** `/api/campaigns/offers`

Retrieves all offer-based campaigns.

**Response (200 OK):**
```json
[
  {
    "id": "campaign123",
    "offerId": "1763917725219kxleeexme",
    "status": "draft",
    "totalRecipients": 112,
    "sentCount": 0,
    "failedCount": 0,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "startedAt": null,
    "completedAt": null
  }
]
```

### 3. Get Specific Offer-Based Campaign

**GET** `/api/campaigns/offers/:id`

Retrieves a specific offer-based campaign with message statistics.

**Response (200 OK):**
```json
{
  "id": "campaign123",
  "offerId": "1763917725219kxleeexme",
  "status": "draft",
  "totalRecipients": 112,
  "sentCount": 0,
  "failedCount": 0,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "messageStats": {
    "total": 112,
    "pending": 112,
    "sent": 0,
    "failed": 0
  }
}
```

### 4. Get Campaigns by Offer ID

**GET** `/api/campaigns/offers/by-offer/:offerId`

Retrieves all campaigns created from a specific offer.

**Response (200 OK):**
```json
[
  {
    "id": "campaign123",
    "offerId": "1763917725219kxleeexme",
    "status": "draft",
    "totalRecipients": 112,
    "sentCount": 0,
    "failedCount": 0
  }
]
```

### 5. Get Campaign Messages

**GET** `/api/campaigns/offers/:id/messages`

Retrieves all messages for a campaign.

**Query Parameters:**
- `status` (optional): Filter by status (`pending`, `sent`, `failed`)

**Response (200 OK):**
```json
{
  "campaignId": "campaign123",
  "count": 112,
  "messages": [
    {
      "id": "msg123",
      "campaignId": "campaign123",
      "clientId": "12345",
      "phone": "01227072811",
      "messageBody": "مرحباً، لدينا عرض خاص لك! Test Offer – July...",
      "status": "pending",
      "sentAt": null,
      "errorMessage": null,
      "createdAt": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

**Example with status filter:**
```bash
curl "http://localhost:3000/api/campaigns/offers/campaign123/messages?status=pending"
```

### 6. Get Campaign Statistics

**GET** `/api/campaigns/offers/:id/stats`

Retrieves detailed statistics for a campaign.

**Response (200 OK):**
```json
{
  "campaignId": "campaign123",
  "campaign": {
    "id": "campaign123",
    "offerId": "1763917725219kxleeexme",
    "status": "draft",
    "totalRecipients": 112,
    "sentCount": 0,
    "failedCount": 0
  },
  "messages": {
    "total": 112,
    "pending": 112,
    "sent": 0,
    "failed": 0
  }
}
```

### 7. Update Campaign

**PUT** `/api/campaigns/offers/:id`

Updates a campaign (typically used to change status).

**Request Body:**
```json
{
  "status": "approved"
}
```

**Status Values:**
- `draft` - Campaign is in draft mode
- `approved` - Campaign is approved and ready to send
- `sending` - Campaign is currently sending messages
- `completed` - Campaign has finished sending

**Response (200 OK):**
```json
{
  "id": "campaign123",
  "offerId": "1763917725219kxleeexme",
  "status": "approved",
  "totalRecipients": 112,
  "sentCount": 0,
  "failedCount": 0,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "startedAt": null,
  "completedAt": null
}
```

**Note:** When status changes to `sending`, `startedAt` is automatically set. When status changes to `completed`, `completedAt` is automatically set.

### 8. Delete Campaign

**DELETE** `/api/campaigns/offers/:id`

Deletes a campaign and all associated messages.

**Response (200 OK):**
```json
{
  "message": "Campaign and associated messages deleted successfully",
  "deleted": true
}
```

## Campaign Messages

### Message Status Values

- `pending` - Message is queued and waiting to be sent
- `sent` - Message was successfully sent
- `failed` - Message failed to send

### Message Fields

- `id` - Unique message ID
- `campaignId` - ID of the parent campaign
- `clientId` - Client ID from TblClient
- `phone` - Phone number to send to
- `messageBody` - The actual message content
- `status` - Current status (pending/sent/failed)
- `sentAt` - Timestamp when message was sent (null if not sent)
- `errorMessage` - Error message if status is 'failed' (null otherwise)
- `createdAt` - Timestamp when message was created

## Complete Flow Example

```bash
# 1. Create an offer
curl -X POST http://localhost:3000/api/offers \
  -H "Content-Type: application/json" \
  -d '{"name": "Summer Sale", "status": "draft"}'

# 2. Add targeting rules
curl -X POST http://localhost:3000/api/offers/{offerId}/targeting \
  -H "Content-Type: application/json" \
  -d '{"cameFrom": "ميامي", "minVisits": 1}'

# 3. Build audience
curl -X POST http://localhost:3000/api/offers/{offerId}/build-audience

# 4. Create campaign
curl -X POST http://localhost:3000/api/campaigns \
  -H "Content-Type: application/json" \
  -d '{"offerId": "{offerId}"}'

# 5. Get campaign details
curl http://localhost:3000/api/campaigns/offers/{campaignId}

# 6. Get campaign messages
curl http://localhost:3000/api/campaigns/offers/{campaignId}/messages

# 7. Get campaign stats
curl http://localhost:3000/api/campaigns/offers/{campaignId}/stats
```

## Data Storage

- Campaigns: `data/offerCampaigns.json`
- Campaign Messages: `data/campaignMessages.json`

Both files are automatically created on first use.

## Notes

- Campaigns are created with status `draft` by default
- All messages are created with status `pending` when campaign is created
- `totalRecipients` is pre-calculated from OfferAudience count
- When campaign status changes to `sending`, `startedAt` is automatically set
- When campaign status changes to `completed`, `completedAt` is automatically set
- Deleting a campaign also deletes all associated messages

