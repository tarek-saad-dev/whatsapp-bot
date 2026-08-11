# Testing Audience Building Flow

This guide walks you through testing the complete audience building flow.

## Prerequisites

1. **Server is running**: `node server.js` or `start-server.bat`
2. **Database is configured**: `.env` file has SQL Server connection details
3. **Database connection works**: SQL Server is accessible

## Test Script (Automated)

Run the automated test script:

```bash
node test-audience-building.js
```

This will:
1. ✅ Create an offer
2. ✅ Add targeting rules
3. ✅ Build audience from SQL Server
4. ✅ Verify stored audience data
5. ✅ Validate data integrity

## Manual Testing (Step by Step)

### Step 1: Create a New Offer

**Request:**
```bash
curl -X POST http://localhost:3000/api/offers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Offer – July",
    "status": "draft",
    "minAge": 18,
    "maxAge": 40
  }'
```

**Or using Postman:**
- Method: `POST`
- URL: `http://localhost:3000/api/offers`
- Headers: `Content-Type: application/json`
- Body:
```json
{
  "name": "Test Offer – July",
  "status": "draft",
  "minAge": 18,
  "maxAge": 40
}
```

**Expected Response:**
```json
{
  "id": "1234567890abcdef",
  "name": "Test Offer – July",
  "description": "",
  "minAge": 18,
  "maxAge": 40,
  "formUrl": null,
  "status": "draft",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

**✅ Save the `id` value - you'll need it for the next steps!**

### Step 2: Add Targeting Rules

**Request:**
```bash
curl -X POST http://localhost:3000/api/offers/<offerId>/targeting \
  -H "Content-Type: application/json" \
  -d '{
    "cameFrom": "ميامي",
    "minVisits": 1,
    "minSpend": 0
  }'
```

**Replace `<offerId>` with the ID from Step 1.**

**Expected Response:**
```json
{
  "id": "rule123",
  "offerId": "1234567890abcdef",
  "gender": null,
  "city": null,
  "maritalStatus": null,
  "cameFrom": "ميامي",
  "lastVisitFrom": null,
  "lastVisitTo": null,
  "minVisits": 1,
  "minSpend": 0,
  "createdAt": "2024-01-15T10:35:00.000Z",
  "updatedAt": "2024-01-15T10:35:00.000Z"
}
```

### Step 3: Build the Audience

**Request:**
```bash
curl -X POST http://localhost:3000/api/offers/<offerId>/build-audience
```

**Expected Response:**
```json
{
  "success": true,
  "offerId": "1234567890abcdef",
  "offerName": "Test Offer – July",
  "rulesCount": 1,
  "audienceCount": 12,
  "members": [
    {
      "clientId": "12345",
      "phone": "201234567890",
      "name": "John Doe",
      "age": 25,
      "maritalStatus": "Single",
      "cameFrom": "ميامي",
      "visitCount": 3,
      "totalSpend": 1500.00,
      "lastVisitDate": "2024-01-10T00:00:00.000Z"
    }
  ],
  "added": 12,
  "updated": 0,
  "total": 12,
  "message": "Successfully built audience with 12 matching clients",
  "timestamp": "2024-01-15T10:40:00.000Z"
}
```

**✅ Note the `audienceCount` - this is how many clients matched your criteria!**

### Step 4: Verify Stored Audience

**Request:**
```bash
curl http://localhost:3000/api/offers/<offerId>/audience
```

**Expected Response:**
```json
{
  "offerId": "1234567890abcdef",
  "offerName": "Test Offer – July",
  "count": 12,
  "audience": [
    {
      "id": "audience123",
      "offerId": "1234567890abcdef",
      "clientId": "12345",
      "phone": "201234567890",
      "matchedAt": "2024-01-15T10:40:00.000Z",
      "createdAt": "2024-01-15T10:40:00.000Z",
      "updatedAt": "2024-01-15T10:40:00.000Z"
    }
  ]
}
```

**Note:** The audience is stored in `data/offerAudience.json` (JSON file storage, not SQL table).

### Step 5: Validate the Data

#### 5.1 Check Audience Count Matches

The `audienceCount` from Step 3 should match the `count` from Step 4.

#### 5.2 Verify ClientID Matches TblClient

Run this SQL query to verify clients exist:

```sql
SELECT 
    c.ClientID,
    c.Name,
    c.Mobile,
    c.BirthDate,
    DATEDIFF(year, c.BirthDate, GETDATE()) as Age,
    c.CameFrom,
    c.State
FROM TblClient c
WHERE DATEDIFF(year, c.BirthDate, GETDATE()) BETWEEN 18 AND 40
  AND c.CameFrom = 'ميامي'
ORDER BY c.ClientID;
```

#### 5.3 Verify Mobile Numbers

Check that phone numbers in the audience match `TblClient.Mobile`:

```sql
SELECT 
    c.ClientID,
    c.Mobile,
    c.Name
FROM TblClient c
WHERE c.ClientID IN (
    -- Get ClientIDs from your audience results
    SELECT ClientID FROM ... -- Use the clientIds from Step 3
)
ORDER BY c.ClientID;
```

#### 5.4 Verify Filters Applied Correctly

Run the same query that the system uses to verify results:

```sql
SELECT 
    c.ClientID as clientId,
    c.Mobile as phone,
    c.Name as name,
    DATEDIFF(year, c.BirthDate, GETDATE()) as age,
    c.State as maritalStatus,
    c.CameFrom as cameFrom,
    COUNT(*) as visitCount,
    ISNULL(SUM(d.SValue), 0) as totalSpend,
    MAX(d.ReservDate) as lastVisitDate
FROM TblClient c
LEFT JOIN TblInvServDetail d
    ON LTRIM(RTRIM(c.Name)) = 
       LTRIM(RTRIM(
           CASE 
               WHEN CHARINDEX(N'/', d.Notes) > 0
                   THEN SUBSTRING(d.Notes, CHARINDEX(N'/', d.Notes) + 1, LEN(d.Notes))
               ELSE d.Notes
           END
       ))
WHERE DATEDIFF(year, c.BirthDate, GETDATE()) BETWEEN 18 AND 40
  AND c.CameFrom = 'ميامي'
GROUP BY 
    c.ClientID,
    c.Mobile,
    c.Name,
    c.BirthDate,
    c.State,
    c.CameFrom,
    c.RegisterDate
HAVING COUNT(*) >= 1
   AND ISNULL(SUM(d.SValue), 0) >= 0
ORDER BY c.ClientID;
```

**This should return the same number of clients as your audience count!**

## Validation Checklist

- [ ] Offer created successfully with correct ID
- [ ] Targeting rules added successfully
- [ ] Audience built successfully (no errors)
- [ ] Audience count > 0 (or 0 if no matches)
- [ ] Stored audience count matches build result count
- [ ] All audience members have ClientID
- [ ] All audience members have phone numbers
- [ ] ClientIDs exist in TblClient
- [ ] Mobile numbers match TblClient.Mobile
- [ ] Age filter applied correctly (18-40)
- [ ] CameFrom filter applied correctly (ميامي)
- [ ] MinVisits filter applied correctly (>= 1)
- [ ] MinSpend filter applied correctly (>= 0)

## Troubleshooting

### No Audience Members Found

**Possible causes:**
1. No clients match the age range (18-40)
2. No clients have `CameFrom = 'ميامي'`
3. No clients have visits (minVisits: 1)
4. Database connection issue
5. SQL query error

**Check:**
- Verify database connection in `.env`
- Check server logs for SQL errors
- Run the SQL query manually to see if any clients match
- Try with less restrictive filters (remove age, cameFrom, etc.)

### Database Connection Error

**Error:** `Login failed for user` or `Cannot connect to server`

**Solution:**
1. Check `.env` file has correct DB credentials
2. Verify SQL Server is running
3. Check firewall settings
4. Test connection manually

### SQL Query Error

**Error:** `Invalid column name` or `Invalid object name`

**Solution:**
1. Verify table names: `TblClient`, `TblInvServDetail`
2. Verify column names match your schema exactly
3. Check the JOIN logic matches your data structure

### Audience Count Mismatch

**Issue:** Build result count doesn't match stored count

**Solution:**
1. Check server logs for errors
2. Verify `data/offerAudience.json` file
3. Try rebuilding the audience

## Success Criteria

✅ **Phase 2 is confirmed working correctly if:**

1. ✅ Offer created successfully
2. ✅ Targeting rules added successfully
3. ✅ Audience built without errors
4. ✅ Audience count matches stored count
5. ✅ All ClientIDs exist in TblClient
6. ✅ All phone numbers match TblClient.Mobile
7. ✅ Filters are applied correctly (age, cameFrom, minVisits, minSpend)

## Next Steps

Once Phase 2 is confirmed working:
- Phase 3: Send messages to the built audience
- Phase 4: Track message delivery and responses
- Phase 5: Analytics and reporting



