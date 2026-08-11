# Fix: Campaign Validation Issue

## Problem

When calling `POST /api/campaigns` with `{ "offerId": "..." }`, the server was returning:
```
Name and segmentType are required
```

## Root Cause

The server was running old code that validated `name` and `segmentType` before checking for `offerId`. The code has been updated, but **the server needs to be restarted** to pick up the changes.

## Solution Applied

1. ✅ Updated validation logic to check for `offerId` FIRST
2. ✅ Only validate `name`/`segmentType` when `offerId` is NOT provided
3. ✅ Added explicit check: `const hasOfferId = offerId !== undefined && offerId !== null && offerId !== '';`
4. ✅ Added debug logging to help diagnose issues

## Action Required

**⚠️ RESTART THE SERVER** to apply the changes:

1. Stop the current server (Ctrl+C in the terminal running `server.js`)
2. Restart the server:
   ```bash
   node server.js
   ```
   Or:
   ```bash
   start-server.bat
   ```

## Verification

After restarting, test with:

```bash
node test-create-campaign.js 1763917725219kxleeexme
```

Or using curl:

```bash
curl -X POST http://localhost:3000/api/campaigns \
  -H "Content-Type: application/json" \
  -d '{"offerId": "1763917725219kxleeexme"}'
```

## Expected Behavior

### With offerId (Offer-Based Campaign):
- ✅ Does NOT require `name` or `segmentType`
- ✅ Validates offer exists
- ✅ Checks audience is built
- ✅ Creates campaign and messages

### Without offerId (Segment-Based Campaign):
- ✅ Requires `name` and `segmentType`
- ✅ Uses legacy segment-based flow

## Code Changes

**File:** `routes/campaigns.js`

**Key Changes:**
1. Check for `offerId` FIRST before any other validation
2. Only validate `name`/`segmentType` in the `else` block (when `offerId` is not provided)
3. Added explicit `hasOfferId` check to handle edge cases

## Debug Logging

The updated code includes console.log statements that will show:
- Whether offerId was detected
- Which flow is being used (offer-based vs segment-based)

These can be removed later if desired.

