# Database Setup Guide

## SQL Server Connection Configuration

To use the Offer Audience Builder feature, you need to configure SQL Server connection settings.

### 1. Environment Variables

Add these variables to your `.env` file:

```env
# SQL Server Connection
DB_SERVER=localhost
DB_NAME=YourDatabaseName
DB_USER=sa
DB_PASSWORD=YourPassword
DB_ENCRYPT=false
DB_TRUST_CERT=true
```

### Configuration Options

- **DB_SERVER**: SQL Server hostname or IP address (default: `localhost`)
- **DB_NAME**: Database name (default: `YourDatabase`)
- **DB_USER**: SQL Server username (default: `sa`)
- **DB_PASSWORD**: SQL Server password (default: empty)
- **DB_ENCRYPT**: Use encryption (default: `false`, set to `true` for Azure)
- **DB_TRUST_CERT**: Trust server certificate (default: `true` for local dev)

### 2. Install Dependencies

Make sure to install the `mssql` package:

```bash
npm install
```

This will install `mssql@^11.0.1` as specified in `package.json`.

### 3. Database Schema Requirements

The system uses the following tables and columns:

#### TblClient (Clients Table)
- `ClientID` - Primary key
- `Name` - Client name
- `Mobile` - Client phone number
- `BirthDate` - Birth date (for age calculation)
- `State` - State/Marital status
- `CameFrom` - Source where client came from (also used for city matching)
- `RegisterDate` - Registration date

#### TblInvServDetail (Invoice/Service Details Table)
- `ID` - Primary key
- `invID` - Invoice ID
- `invType` - Invoice type
- `SValue` - Service value/amount (for total spend calculation)
- `Notes` - Notes field (contains client name for JOIN)
- `ReservDate` - Reservation/Visit date (for last visit calculation)

#### JOIN Logic
The tables are joined using a complex condition:
- `TblClient.Name` matches parsed value from `TblInvServDetail.Notes`
- If Notes contains '/', uses the part after '/'
- Otherwise uses the entire Notes field
- Both sides are trimmed (LTRIM/RTRIM)

### 4. Field Mappings

The system maps targeting rules to database fields as follows:

- **Phone**: `TblClient.Mobile`
- **Age**: Calculated from `TblClient.BirthDate` using `DATEDIFF(year, BirthDate, GETDATE())`
- **LastVisit**: `TblInvServDetail.ReservDate` (MAX value)
- **City**: Uses `TblClient.CameFrom` for city matching
- **MaritalStatus**: Uses `TblClient.State`
- **TotalSpend**: `SUM(TblInvServDetail.SValue)`
- **MinVisits**: `COUNT(*)` from `TblInvServDetail` for each client

### 5. Query Structure

The SQL query:
1. Joins `TblClient` with `TblInvServDetail` using the complex Name/Notes matching logic
2. Groups by client to calculate aggregated values (visit count, total spend)
3. Applies WHERE conditions for non-aggregated filters (age, city, marital status, etc.)
4. Applies HAVING conditions for aggregated filters (minVisits, minSpend)

### 6. Test Connection

You can test the database connection by:

1. Starting the server: `node server.js`
2. The connection will be established automatically when you call the build-audience endpoint
3. Check server logs for connection status

### 7. Troubleshooting

#### Connection Errors

**Error: "Login failed for user"**
- Check DB_USER and DB_PASSWORD in `.env`
- Verify SQL Server authentication mode (SQL Server Authentication vs Windows Authentication)

**Error: "Cannot connect to server"**
- Check DB_SERVER is correct
- Verify SQL Server is running
- Check firewall settings
- Verify SQL Server allows remote connections

**Error: "Database does not exist"**
- Check DB_NAME is correct
- Verify database exists on the server

#### Query Errors

**Error: "Invalid column name"**
- Adjust column names in `services/offerAudienceBuilder.js` to match your schema
- Check table and column names are correct

**Error: "Invalid object name"**
- Adjust table names in `services/offerAudienceBuilder.js` to match your schema
- Verify tables exist in the database

### 8. Security Notes

- **Never commit `.env` file** to version control
- Use strong passwords for production
- Consider using Windows Authentication for better security
- Use encrypted connections (DB_ENCRYPT=true) in production
- Restrict database user permissions to only necessary tables

### 9. Production Recommendations

1. Use connection pooling (already implemented)
2. Set appropriate timeout values
3. Use read-only database user if possible
4. Monitor query performance
5. Add indexes on frequently queried columns:
   - `TblClient.ClientID`
   - `TblClient.Name` (for JOIN performance)
   - `TblInvServDetail.Notes` (for JOIN performance)
   - `TblInvServDetail.ReservDate` (for date filtering)
6. Consider adding computed column or index on the parsed Notes value for better JOIN performance

