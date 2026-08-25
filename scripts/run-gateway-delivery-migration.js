#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getPool, closeConnection, getDbConfig } = require('../services/database');

function assertSafeConfig() {
    const cfg = getDbConfig();
    const server = String(cfg.server || '').trim();
    if (!server || /YOUR_PC_NAME_OR_IP/i.test(server)) {
        throw new Error('DB_SERVER is missing or still a placeholder. Refusing to run migration.');
    }
    if (/database\.windows\.net/i.test(server) && process.env.ALLOW_AZURE_SQL_MIGRATION !== 'true') {
        throw new Error('Refusing public Azure SQL unless ALLOW_AZURE_SQL_MIGRATION=true.');
    }
    const port = cfg.port || 1433;
    console.log(`Using SQL server=${server} port=${port} database=${cfg.database}`);
}

async function runBatches(pool, sqlText) {
    const batches = sqlText
        .split(/^\s*GO\s*$/gim)
        .map((b) => b.trim())
        .filter(Boolean);
    console.log(`batches ${batches.length}`);
    for (let i = 0; i < batches.length; i += 1) {
        console.log(`running batch ${i + 1}`);
        await pool.request().batch(batches[i]);
    }
    return batches.length;
}

async function verify(pool) {
    const result = await pool.request().query(`
        SELECT
            t.name AS TableName,
            c.name AS ColumnName,
            ty.name AS TypeName
        FROM sys.tables t
        JOIN sys.columns c ON c.object_id = t.object_id
        JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE t.name = N'TblWhatsAppGatewayDelivery'
        ORDER BY c.column_id
    `);
    console.table(result.recordset);

    const indexes = await pool.request().query(`
        SELECT i.name AS IndexName, i.is_unique AS IsUnique
        FROM sys.indexes i
        WHERE i.object_id = OBJECT_ID(N'dbo.TblWhatsAppGatewayDelivery')
          AND i.name IS NOT NULL
        ORDER BY i.name
    `);
    console.table(indexes.recordset);
}

async function main() {
    assertSafeConfig();
    const sqlPath = path.join(__dirname, '..', 'sql', 'create-tbl-whatsapp-gateway-delivery.sql');
    const sqlText = fs.readFileSync(sqlPath, 'utf8');
    const pool = await getPool();

    await runBatches(pool, sqlText);
    await verify(pool);

    console.log('Re-running migration to prove idempotency...');
    await runBatches(pool, sqlText);
    console.log('Idempotent re-run OK');

    await closeConnection();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
