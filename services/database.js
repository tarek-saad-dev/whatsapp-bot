/**
 * SQL Server Database Connection Service
 * Handles connection to SQL Server database
 */

const sql = require('mssql');

let pool = null;

/**
 * Get database configuration from environment variables
 */
function getDbConfig() {
    const port = parseInt(process.env.DB_PORT || '1433', 10);
    return {
        server: process.env.DB_SERVER || 'DESKTOP-EUN2CV2',
        port: Number.isFinite(port) ? port : 1433,
        database: process.env.DB_NAME || process.env.DB_DATABASE || 'HawaiDB',
        user: process.env.DB_USER || 'it',
        password: process.env.DB_PASSWORD || '123',
        options: {
            encrypt: process.env.DB_ENCRYPT === 'true', // Use true for Azure
            trustServerCertificate:
                process.env.DB_TRUST_CERT === 'true' ||
                process.env.DB_TRUST_SERVER_CERTIFICATE === 'true',
            enableArithAbort: true,
            connectionTimeout: 30000,
            requestTimeout: 30000
        },
        pool: {
            max: 10,
            min: 0,
            idleTimeoutMillis: 30000
        }
    };
}

/**
 * Get or create database connection pool
 */
async function getPool() {
    if (pool) {
        return pool;
    }
    
    try {
        const config = getDbConfig();
        pool = await sql.connect(config);
        console.log('✅ Connected to SQL Server database');
        return pool;
    } catch (error) {
        console.error('❌ Database connection error:', error.message);
        throw error;
    }
}

/**
 * Execute a SQL query
 * @param {string} query - SQL query string
 * @param {object} params - Query parameters (optional)
 * @returns {Promise<object>} Query result
 */
async function executeQuery(query, params = {}) {
    try {
        const pool = await getPool();
        const request = pool.request();
        
        // Add parameters if provided
        Object.keys(params).forEach(key => {
            request.input(key, params[key]);
        });
        
        const result = await request.query(query);
        return result.recordset;
    } catch (error) {
        console.error('❌ Query execution error:', error.message);
        throw error;
    }
}

/**
 * Close database connection
 */
async function closeConnection() {
    if (pool) {
        await pool.close();
        pool = null;
        console.log('✅ Database connection closed');
    }
}

/**
 * Test database connection
 */
async function testConnection() {
    try {
        const pool = await getPool();
        const result = await pool.request().query('SELECT 1 as test');
        return result.recordset.length > 0;
    } catch (error) {
        console.error('❌ Connection test failed:', error.message);
        return false;
    }
}

module.exports = {
    getPool,
    executeQuery,
    closeConnection,
    testConnection,
    getDbConfig
};



