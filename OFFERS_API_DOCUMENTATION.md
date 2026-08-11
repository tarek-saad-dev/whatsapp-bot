# Offers API Documentation

## Overview

This document describes the API endpoints for managing Offers and Offer Targeting Rules.

## Base URL

```
http://localhost:3000/api/offers
```

## Offer Endpoints

### 1. Create a New Offer

**POST** `/api/offers`

Creates a new offer with the specified details.

**Request Body:**
```json
{
  "name": "Winter Offer",
  "description": "50% discount for 1 week",
  "minAge": 18,
  "maxAge": 35,
  "formUrl": "https://forms.google.com/myform",
  "status": "draft"
}
```

**Field Descriptions:**
- `name` (required): Name of the offer
- `description` (optional): Description of the offer
- `minAge` (optional): Minimum age requirement (integer, nullable)
- `maxAge` (optional): Maximum age requirement (integer, nullable)
- `formUrl` (optional): URL to a form (string, nullable)
- `status` (optional): Status of the offer - must be one of: `draft`, `active`, `expired` (default: `draft`)

**Response (201 Created):**
```json
{
  "id": "1234567890abcdef",
  "name": "Winter Offer",
  "description": "50% discount for 1 week",
  "minAge": 18,
  "maxAge": 35,
  "formUrl": "https://forms.google.com/myform",
  "status": "draft",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

**Example using cURL:**
```bash
curl -X POST http://localhost:3000/api/offers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Winter Offer",
    "description": "50% discount for 1 week",
    "minAge": 18,
    "maxAge": 35,
    "formUrl": "https://forms.google.com/myform",
    "status": "draft"
  }'
```

### 2. Get All Offers

**GET** `/api/offers`

Retrieves all offers.

**Response (200 OK):**
```json
[
  {
    "id": "1234567890abcdef",
    "name": "Winter Offer",
    "description": "50% discount for 1 week",
    "minAge": 18,
    "maxAge": 35,
    "formUrl": "https://forms.google.com/myform",
    "status": "draft",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
]
```

### 3. Get a Specific Offer

**GET** `/api/offers/:id`

Retrieves a specific offer by ID, including its targeting rules.

**Response (200 OK):**
```json
{
  "id": "1234567890abcdef",
  "name": "Winter Offer",
  "description": "50% discount for 1 week",
  "minAge": 18,
  "maxAge": 35,
  "formUrl": "https://forms.google.com/myform",
  "status": "draft",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z",
  "targetingRules": [
    {
      "id": "rule123",
      "offerId": "1234567890abcdef",
      "gender": "female",
      "city": "Cairo",
      "maritalStatus": "single",
      "cameFrom": "instagram",
      "lastVisitFrom": "2024-01-01",
      "lastVisitTo": "2024-01-15",
      "minVisits": 3,
      "minSpend": 500.00,
      "createdAt": "2024-01-15T10:35:00.000Z",
      "updatedAt": "2024-01-15T10:35:00.000Z"
    }
  ]
}
```

### 4. Update an Offer

**PUT** `/api/offers/:id`

Updates an existing offer.

**Request Body:**
```json
{
  "name": "Winter Offer Updated",
  "status": "active",
  "description": "Updated description"
}
```

**Response (200 OK):**
```json
{
  "id": "1234567890abcdef",
  "name": "Winter Offer Updated",
  "description": "Updated description",
  "minAge": 18,
  "maxAge": 35,
  "formUrl": "https://forms.google.com/myform",
  "status": "active",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T11:00:00.000Z"
}
```

### 5. Delete an Offer

**DELETE** `/api/offers/:id`

Deletes an offer and all its associated targeting rules.

**Response (200 OK):**
```json
{
  "message": "Offer and associated targeting rules deleted successfully"
}
```

## Targeting Rules Endpoints

### 1. Create Targeting Rules for an Offer

**POST** `/api/offers/:id/targeting`

Creates targeting rules for a specific offer.

**Request Body:**
```json
{
  "gender": "female",
  "city": "Cairo",
  "maritalStatus": "single",
  "cameFrom": "instagram",
  "lastVisitFrom": "2024-01-01",
  "lastVisitTo": "2024-01-15",
  "minVisits": 3,
  "minSpend": 500.00
}
```

**Field Descriptions:**
- `gender` (optional): Target gender (string, nullable)
- `city` (optional): Target city (string, nullable)
- `maritalStatus` (optional): Marital status (string, nullable)
- `cameFrom` (optional): Source where customer came from (string, nullable)
- `lastVisitFrom` (optional): Start date for last visit range (string, nullable)
- `lastVisitTo` (optional): End date for last visit range (string, nullable)
- `minVisits` (optional): Minimum number of visits (integer, nullable)
- `minSpend` (optional): Minimum spending amount (float, nullable)

**Response (201 Created):**
```json
{
  "id": "rule123",
  "offerId": "1234567890abcdef",
  "gender": "female",
  "city": "Cairo",
  "maritalStatus": "single",
  "cameFrom": "instagram",
  "lastVisitFrom": "2024-01-01",
  "lastVisitTo": "2024-01-15",
  "minVisits": 3,
  "minSpend": 500.00,
  "createdAt": "2024-01-15T10:35:00.000Z",
  "updatedAt": "2024-01-15T10:35:00.000Z"
}
```

**Example using cURL:**
```bash
curl -X POST http://localhost:3000/api/offers/1234567890abcdef/targeting \
  -H "Content-Type: application/json" \
  -d '{
    "gender": "female",
    "city": "Cairo",
    "maritalStatus": "single",
    "cameFrom": "instagram",
    "lastVisitFrom": "2024-01-01",
    "lastVisitTo": "2024-01-15",
    "minVisits": 3,
    "minSpend": 500.00
  }'
```

### 2. Get All Targeting Rules for an Offer

**GET** `/api/offers/:id/targeting`

Retrieves all targeting rules for a specific offer.

**Response (200 OK):**
```json
[
  {
    "id": "rule123",
    "offerId": "1234567890abcdef",
    "gender": "female",
    "city": "Cairo",
    "maritalStatus": "single",
    "cameFrom": "instagram",
    "lastVisitFrom": "2024-01-01",
    "lastVisitTo": "2024-01-15",
    "minVisits": 3,
    "minSpend": 500.00,
    "createdAt": "2024-01-15T10:35:00.000Z",
    "updatedAt": "2024-01-15T10:35:00.000Z"
  }
]
```

### 3. Update a Targeting Rule

**PUT** `/api/offers/:id/targeting/:ruleId`

Updates a specific targeting rule.

**Request Body:**
```json
{
  "city": "Alexandria",
  "minSpend": 750.00
}
```

**Response (200 OK):**
```json
{
  "id": "rule123",
  "offerId": "1234567890abcdef",
  "gender": "female",
  "city": "Alexandria",
  "maritalStatus": "single",
  "cameFrom": "instagram",
  "lastVisitFrom": "2024-01-01",
  "lastVisitTo": "2024-01-15",
  "minVisits": 3,
  "minSpend": 750.00,
  "createdAt": "2024-01-15T10:35:00.000Z",
  "updatedAt": "2024-01-15T11:00:00.000Z"
}
```

### 4. Delete a Targeting Rule

**DELETE** `/api/offers/:id/targeting/:ruleId`

Deletes a specific targeting rule.

**Response (200 OK):**
```json
{
  "message": "Targeting rule deleted successfully"
}
```

## Error Responses

All endpoints may return the following error responses:

**400 Bad Request:**
```json
{
  "error": "Name is required"
}
```

**404 Not Found:**
```json
{
  "error": "Offer not found"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Error message"
}
```

## Data Storage

- Offers are stored in `data/offers.json`
- Targeting rules are stored in `data/offerTargetingRules.json`

Both files are automatically created on first use.

## Status Values

Offer status can be one of:
- `draft` - Offer is in draft mode
- `active` - Offer is currently active
- `expired` - Offer has expired

## Audience Endpoints

### 1. Build Audience for an Offer

**POST** `/api/offers/:id/build-audience`

Builds the target audience from SQL Server based on the offer's targeting rules.

**Response (200 OK):**
```json
{
  "success": true,
  "offerId": "1234567890abcdef",
  "offerName": "Winter Offer",
  "rulesCount": 2,
  "audienceCount": 150,
  "members": [
    {
      "clientId": "12345",
      "phone": "201234567890",
      "name": "John Doe",
      "visitCount": 5,
      "totalSpend": 1250.00,
      "lastVisitDate": "2024-01-10T00:00:00.000Z"
    }
  ],
  "added": 150,
  "updated": 0,
  "total": 150,
  "message": "Successfully built audience with 150 matching clients",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**Example using cURL:**
```bash
curl -X POST http://localhost:3000/api/offers/1234567890abcdef/build-audience
```

**Note:** This endpoint:
- Queries SQL Server (TblClient and TblinvServDetail tables)
- Filters clients based on targeting rules
- Saves results to OfferAudience table
- Replaces any existing audience for this offer

### 2. Get Audience for an Offer

**GET** `/api/offers/:id/audience`

Retrieves all audience members for a specific offer.

**Response (200 OK):**
```json
{
  "offerId": "1234567890abcdef",
  "offerName": "Winter Offer",
  "count": 150,
  "audience": [
    {
      "id": "audience123",
      "offerId": "1234567890abcdef",
      "clientId": "12345",
      "phone": "201234567890",
      "matchedAt": "2024-01-15T10:30:00.000Z",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

### 3. Get Audience Count

**GET** `/api/offers/:id/audience/count`

Gets the count of audience members for an offer.

**Response (200 OK):**
```json
{
  "offerId": "1234567890abcdef",
  "offerName": "Winter Offer",
  "count": 150
}
```

### 4. Delete Audience

**DELETE** `/api/offers/:id/audience`

Deletes all audience members for an offer.

**Response (200 OK):**
```json
{
  "message": "Audience deleted successfully",
  "deleted": true
}
```

## Summary Endpoint

### Get Campaign Summary

**GET** `/api/offers/:id/summary`

Retrieves a comprehensive summary of an offer including offer details, targeting rules, audience count, preview, and message preview. This endpoint is designed for the "Summary Screen" before launching a campaign.

**Response (200 OK):**
```json
{
  "offer": {
    "id": "1234567890abcdef",
    "name": "Test Offer – July",
    "description": "50% discount for 1 week",
    "status": "draft",
    "minAge": 18,
    "maxAge": 40,
    "formUrl": "https://forms.google.com/myform",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  },
  "targeting": [
    {
      "id": "rule123",
      "gender": null,
      "city": null,
      "maritalStatus": null,
      "cameFrom": "ميامي",
      "lastVisitFrom": null,
      "lastVisitTo": null,
      "minVisits": 1,
      "minSpend": 0
    }
  ],
  "audienceCount": 112,
  "audiencePreview": [
    {
      "name": "طارق سعد",
      "phone": "01227072811"
    },
    {
      "name": "أحمد محمد",
      "phone": "01234567890"
    }
  ],
  "messagePreview": "مرحباً طارق سعد، لدينا عرض خاص لك! Test Offer – July. 50% discount for 1 week اضغط على الرابط للتسجيل: https://forms.google.com/myform"
}
```

**Response when no audience built (200 OK):**
```json
{
  "offer": { ... },
  "targeting": [ ... ],
  "audienceCount": 0,
  "audiencePreview": [],
  "messagePreview": "مرحباً طارق سعد، لدينا عرض خاص لك! Test Offer – July. نتمنى أن ينال إعجابك."
}
```

**Error Response (404 Not Found):**
```json
{
  "error": "Offer not found",
  "message": "No offer found with ID: 1234567890abcdef"
}
```

**Example using cURL:**
```bash
curl http://localhost:3000/api/offers/1234567890abcdef/summary
```

**Response Fields:**
- `offer`: Complete offer information (id, name, description, status, minAge, maxAge, formUrl, createdAt, updatedAt)
- `targeting`: Array of all targeting rules for this offer
- `audienceCount`: Total number of audience members (0 if not built yet)
- `audiencePreview`: Array of 3-5 sample audience members with name and phone (empty if no audience)
- `messagePreview`: Sample WhatsApp message that will be sent (uses first audience member's name or default)

**Notes:**
- This endpoint is read-only (no side effects)
- Fast response time (optimized for frontend display)
- Audience preview fetches names from SQL Server (TblClient table)
- Message preview uses offer name, description, and formUrl if available
- If no audience is built, `audienceCount` is 0 and `audiencePreview` is empty

## Notes

- All dates should be in ISO 8601 format (YYYY-MM-DD or full ISO datetime)
- Numeric fields (minAge, maxAge, minVisits, minSpend) are automatically converted to appropriate types
- When an offer is deleted, all associated targeting rules and audience are also deleted
- Multiple targeting rules can be created for a single offer
- The build-audience endpoint requires SQL Server connection (see DATABASE_SETUP.md)
- Audience is built from SQL Server tables: TblClient and TblInvServDetail
- Summary endpoint requires SQL Server connection to fetch audience preview names

