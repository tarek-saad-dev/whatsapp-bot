'use strict';

const sql = require('mssql');
const { getPool } = require('../database');
const { STATUSES } = require('./constants');

function isDuplicateKeyError(err) {
    if (!err) return false;
    if (err.number === 2627 || err.number === 2601) return true;
    const message = String(err.message || '');
    return /unique|duplicate key/i.test(message);
}

function mapRow(record) {
    if (!record) return null;
    return {
        id: Number(record.ID),
        idempotencyKey: record.IdempotencyKey,
        requestHash: String(record.RequestHash || '').trim(),
        phone: record.Phone,
        status: record.Status,
        providerMessageId: record.ProviderMessageID || null,
        attemptCount: Number(record.AttemptCount),
        lastError: record.LastError || null,
        createdAt: record.CreatedAt,
        updatedAt: record.UpdatedAt || null,
        sentAt: record.SentAt || null,
    };
}

const SELECT_COLUMNS = `
    [ID],
    [IdempotencyKey],
    [RequestHash],
    [Phone],
    [Status],
    [ProviderMessageID],
    [AttemptCount],
    [LastError],
    [CreatedAt],
    [UpdatedAt],
    [SentAt]
`;

function createSqlDeliveryStore() {
    return {
        kind: 'sql',

        async insertClaim({ key, hash, phone }) {
            const pool = await getPool();
            try {
                await pool.request()
                    .input('key', sql.NVarChar(200), key)
                    .input('hash', sql.Char(64), hash)
                    .input('phone', sql.NVarChar(50), phone)
                    .query(`
                        INSERT INTO [dbo].[TblWhatsAppGatewayDelivery]
                            ([IdempotencyKey], [RequestHash], [Phone], [Status], [AttemptCount], [CreatedAt])
                        VALUES
                            (@key, @hash, @phone, N'processing', 1, SYSUTCDATETIME())
                    `);
                return { inserted: true };
            } catch (err) {
                if (isDuplicateKeyError(err)) {
                    return { inserted: false };
                }
                throw err;
            }
        },

        async getByKey(key) {
            const pool = await getPool();
            const result = await pool.request()
                .input('key', sql.NVarChar(200), key)
                .query(`
                    SELECT ${SELECT_COLUMNS}
                    FROM [dbo].[TblWhatsAppGatewayDelivery]
                    WHERE [IdempotencyKey] = @key
                `);
            return mapRow(result.recordset[0]);
        },

        async claimRetryableFailed(key) {
            const pool = await getPool();
            const result = await pool.request()
                .input('key', sql.NVarChar(200), key)
                .query(`
                    UPDATE [dbo].[TblWhatsAppGatewayDelivery]
                    SET [Status] = N'processing',
                        [AttemptCount] = [AttemptCount] + 1,
                        [UpdatedAt] = SYSUTCDATETIME(),
                        [LastError] = NULL
                    OUTPUT INSERTED.ID, INSERTED.AttemptCount, INSERTED.Status
                    WHERE [IdempotencyKey] = @key
                      AND [Status] = N'retryable_failed'
                `);
            const row = result.recordset[0];
            if (!row) {
                return { claimed: false };
            }
            return {
                claimed: true,
                row: {
                    id: Number(row.ID),
                    attemptCount: Number(row.AttemptCount),
                    status: row.Status,
                },
            };
        },

        async markSent(key, providerMessageId) {
            const pool = await getPool();
            const result = await pool.request()
                .input('key', sql.NVarChar(200), key)
                .input('messageId', sql.NVarChar(250), providerMessageId)
                .query(`
                    UPDATE [dbo].[TblWhatsAppGatewayDelivery]
                    SET [Status] = N'sent',
                        [ProviderMessageID] = @messageId,
                        [SentAt] = SYSUTCDATETIME(),
                        [UpdatedAt] = SYSUTCDATETIME(),
                        [LastError] = NULL
                    WHERE [IdempotencyKey] = @key
                      AND [Status] = N'processing'
                `);
            return { updated: result.rowsAffected[0] === 1 };
        },

        async markRetryableFailed(key, lastError) {
            const pool = await getPool();
            const result = await pool.request()
                .input('key', sql.NVarChar(200), key)
                .input('lastError', sql.NVarChar(sql.MAX), lastError || null)
                .query(`
                    UPDATE [dbo].[TblWhatsAppGatewayDelivery]
                    SET [Status] = N'retryable_failed',
                        [LastError] = @lastError,
                        [UpdatedAt] = SYSUTCDATETIME()
                    WHERE [IdempotencyKey] = @key
                      AND [Status] = N'processing'
                `);
            return { updated: result.rowsAffected[0] === 1 };
        },

        async markUnknown(key, lastError) {
            const pool = await getPool();
            const result = await pool.request()
                .input('key', sql.NVarChar(200), key)
                .input('lastError', sql.NVarChar(sql.MAX), lastError || null)
                .query(`
                    UPDATE [dbo].[TblWhatsAppGatewayDelivery]
                    SET [Status] = N'unknown',
                        [LastError] = @lastError,
                        [UpdatedAt] = SYSUTCDATETIME()
                    WHERE [IdempotencyKey] = @key
                      AND [Status] <> N'sent'
                `);
            return { updated: result.rowsAffected[0] === 1 };
        },

        async deleteByKey(key) {
            const pool = await getPool();
            const result = await pool.request()
                .input('key', sql.NVarChar(200), key)
                .query(`
                    DELETE FROM [dbo].[TblWhatsAppGatewayDelivery]
                    WHERE [IdempotencyKey] = @key
                `);
            return result.rowsAffected[0] > 0;
        },
    };
}

module.exports = {
    createSqlDeliveryStore,
    isDuplicateKeyError,
    STATUSES,
};
