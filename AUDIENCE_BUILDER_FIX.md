# Fix: Audience Builder SQL Query Structure

## Problem

The audience builder was using incorrect SQL structure:
- Used `TblInvServDetail` with complex name-based JOIN
- Tried to parse client names from `Notes` field
- Did not properly link visits to clients

## Solution

Updated to use the **correct database structure**:
- Use `TblinvServHead` (not `TblInvServDetail`)
- Join on `ClientID` (direct, reliable link)
- Use `invDate` from `TblinvServHead` for visit dates
- Use `GrandTotal` for spend calculations

## Changes Made

### File: `services/offerAudienceBuilder.js`

#### 1. Updated JOIN Structure

**Before (Incorrect):**
```sql
FROM TblClient c
LEFT JOIN TblInvServDetail d
    ON LTRIM(RTRIM(c.Name)) = LTRIM(RTRIM(...parsed Notes...))
```

**After (Correct):**
```sql
FROM TblClient c
LEFT JOIN TblinvServHead h
    ON c.ClientID = h.ClientID
```

#### 2. Updated Date Filtering

**Before:**
- Used `ReservDate` from `TblInvServDetail`
- Complex name parsing

**After:**
- Uses `invDate` from `TblinvServHead`
- Direct `ClientID` link

#### 3. Updated Spend Calculation

**Before:**
- Used `SValue` from `TblInvServDetail`

**After:**
- Uses `GrandTotal` from `TblinvServHead`

#### 4. Updated Aggregations

**Before:**
- Mixed WHERE and HAVING clauses incorrectly

**After:**
- WHERE: Non-aggregated filters (CameFrom, State, etc.)
- HAVING: Aggregated filters (COUNT, SUM, MAX) after GROUP BY

## Query Structure

### Base Query:
```sql
SELECT 
    c.ClientID as clientId,
    c.Mobile as phone,
    c.Name as name,
    DATEDIFF(year, c.BirthDate, GETDATE()) as age,
    c.State as maritalStatus,
    c.CameFrom as cameFrom,
    c.BirthDate as birthDate,
    c.RegisterDate as registerDate,
    COUNT(h.invID) as visitCount,
    ISNULL(SUM(h.GrandTotal), 0) as totalSpend,
    MAX(h.invDate) as lastVisitDate
FROM TblClient c
LEFT JOIN TblinvServHead h
    ON c.ClientID = h.ClientID
WHERE
    -- Non-aggregated filters (CameFrom, State, etc.)
GROUP BY 
    c.ClientID,
    c.Mobile,
    c.Name,
    c.BirthDate,
    c.State,
    c.CameFrom,
    c.RegisterDate
HAVING
    -- Aggregated filters (age, minVisits, minSpend, date ranges)
ORDER BY c.ClientID
```

## Filter Implementation

### WHERE Clause (Before GROUP BY):
- `c.CameFrom = @value` - Direct client attribute
- `c.State = @value` - Direct client attribute
- `c.City = @value` - If applicable

### HAVING Clause (After GROUP BY):
- `DATEDIFF(year, c.BirthDate, GETDATE()) BETWEEN @minAge AND @maxAge` - Age calculation
- `COUNT(h.invID) >= @minVisits` - Visit count
- `SUM(h.GrandTotal) >= @minSpend` - Total spend
- `MAX(h.invDate) BETWEEN @startDate AND @endDate` - Last visit date range

## Key Improvements

1. ✅ **Reliable JOIN**: Uses `ClientID` (primary key link)
2. ✅ **Correct Table**: Uses `TblinvServHead` (has visit dates and totals)
3. ✅ **Proper Aggregation**: Filters in correct clauses (WHERE vs HAVING)
4. ✅ **Removed Name Parsing**: No more unreliable Notes field parsing
5. ✅ **Correct Date Field**: Uses `invDate` from header table

## Testing

After this fix, the audience builder should:
- Return correct client counts
- Match clients based on actual visit data
- Filter correctly by date ranges
- Calculate spend and visit counts accurately

## Database Schema Reference

### TblClient
- `ClientID` (PK)
- `Name`
- `Mobile`
- `BirthDate`
- `State`
- `CameFrom`
- `RegisterDate`

### TblinvServHead
- `ClientID` (FK → TblClient.ClientID)
- `invID` (PK)
- `invDate` (visit date)
- `GrandTotal` (total amount)

### Join Relationship
```
TblClient.ClientID = TblinvServHead.ClientID
```

## Notes

- `TblInvServDetail` is no longer used for audience building
- Name-based matching has been removed
- All date filtering uses `invDate` from header table
- Spend calculations use `GrandTotal` from header table



