# Phase 2 Testing Guide

## ⚠️ IMPORTANT: Server Restart Required

**Before testing, you MUST restart the server** to pick up the route changes:

1. Stop the current server (Ctrl+C)
2. Start it again: `node server.js` or `start-server.bat`

The summary route was moved to fix the routing order, but the server needs to be restarted for changes to take effect.

## Test with Real Offer ID

Your offer ID: `1763917725219kxleeexme`

### Quick Test Commands

```bash
# 1. Test summary endpoint
node test-offer-summary.js 1763917725219kxleeexme

# 2. Complete Phase 2 test
node test-complete-phase2.js

# 3. Or use curl
curl http://localhost:3000/api/offers/1763917725219kxleeexme/summary
```

## Expected Results

### ✅ If Working Correctly:

**Summary Response:**
```json
{
  "offer": {
    "id": "1763917725219kxleeexme",
    "name": "Test Offer – July",
    "status": "draft",
    "minAge": 18,
    "maxAge": 40
  },
  "targeting": [
    {
      "cameFrom": "ميامي",
      "minVisits": 1,
      "minSpend": 0
    }
  ],
  "audienceCount": 0,
  "audiencePreview": [],
  "messagePreview": "..."
}
```

### ❌ If Still Getting HTML:

**Error:** `Cannot GET /api/offers/.../summary`

**Solution:**
1. **Restart the server** (most likely fix)
2. Check server logs for route registration
3. Verify `routes/offers.js` has the summary route at line 24 (before `/:id` route)

## Complete Test Flow

1. **Get Offer** ✅ (Working)
   - `GET /api/offers/1763917725219kxleeexme`

2. **Get Targeting Rules** ✅ (Working)
   - `GET /api/offers/1763917725219kxleeexme/targeting`

3. **Build Audience** ✅ (Working - returns 0 matches, which is OK)
   - `POST /api/offers/1763917725219kxleeexme/build-audience`

4. **Get Summary** ⚠️ (Needs server restart)
   - `GET /api/offers/1763917725219kxleeexme/summary`

## Troubleshooting

### Route Not Found (404 HTML)

**Cause:** Server not restarted after route changes

**Fix:**
```bash
# Stop server (Ctrl+C in the terminal running server.js)
# Then restart:
node server.js
```

### Database Connection Issues

If building audience fails:
- Check `.env` has correct DB credentials
- Verify SQL Server is running
- Check server logs for connection errors

### Empty Audience (0 matches)

This is **OK** if:
- No clients match the targeting criteria
- Database query returns no results
- Targeting rules are too restrictive

To test with data:
- Adjust targeting rules to be less restrictive
- Or add test data to your database

## Verification Checklist

After restarting the server, verify:

- [ ] Server starts without errors
- [ ] `GET /api/offers/1763917725219kxleeexme` returns JSON
- [ ] `GET /api/offers/1763917725219kxleeexme/targeting` returns JSON
- [ ] `GET /api/offers/1763917725219kxleeexme/summary` returns JSON (not HTML)
- [ ] Summary response has all required fields:
  - [ ] `offer` object
  - [ ] `targeting` array
  - [ ] `audienceCount` number
  - [ ] `audiencePreview` array
  - [ ] `messagePreview` string

## Next Steps After Verification

Once all tests pass:
- ✅ Phase 2 is complete and working
- Ready to proceed to Phase 3 (sending messages to audience)

