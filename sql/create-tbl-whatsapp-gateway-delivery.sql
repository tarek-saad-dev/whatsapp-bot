-- ============================================================
-- Migration: TblWhatsAppGatewayDelivery (Phase 5B Gateway idempotency)
-- Gateway-specific durable delivery ledger. Idempotent. Safe to re-run.
-- Does not touch ERP business tables.
-- ============================================================
SET NOCOUNT ON;

IF OBJECT_ID(N'dbo.TblWhatsAppGatewayDelivery', N'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[TblWhatsAppGatewayDelivery] (
        [ID]                 BIGINT         IDENTITY(1,1) NOT NULL,
        [IdempotencyKey]     NVARCHAR(200)  NOT NULL,
        [RequestHash]        CHAR(64)       NOT NULL,
        [Phone]              NVARCHAR(50)   NOT NULL,
        [Status]             NVARCHAR(30)   NOT NULL,
        [ProviderMessageID]  NVARCHAR(250)  NULL,
        [AttemptCount]       INT            NOT NULL
            CONSTRAINT [DF_TblWhatsAppGatewayDelivery_AttemptCount] DEFAULT (0),
        [LastError]          NVARCHAR(MAX)  NULL,
        [CreatedAt]          DATETIME2(0)   NOT NULL
            CONSTRAINT [DF_TblWhatsAppGatewayDelivery_CreatedAt] DEFAULT (SYSUTCDATETIME()),
        [UpdatedAt]          DATETIME2(0)   NULL,
        [SentAt]             DATETIME2(0)   NULL,
        CONSTRAINT [PK_TblWhatsAppGatewayDelivery] PRIMARY KEY CLUSTERED ([ID]),
        CONSTRAINT [UQ_TblWhatsAppGatewayDelivery_IdempotencyKey] UNIQUE ([IdempotencyKey]),
        CONSTRAINT [CK_TblWhatsAppGatewayDelivery_IdempotencyKey]
            CHECK (LEN(LTRIM(RTRIM([IdempotencyKey]))) > 0),
        CONSTRAINT [CK_TblWhatsAppGatewayDelivery_AttemptCount]
            CHECK ([AttemptCount] >= 0),
        CONSTRAINT [CK_TblWhatsAppGatewayDelivery_Status]
            CHECK ([Status] IN (N'processing', N'sent', N'retryable_failed', N'unknown'))
    );
    PRINT N'Created TblWhatsAppGatewayDelivery';
END
ELSE
    PRINT N'TblWhatsAppGatewayDelivery already exists';
GO

IF OBJECT_ID(N'dbo.TblWhatsAppGatewayDelivery', N'U') IS NOT NULL
AND NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'UQ_TblWhatsAppGatewayDelivery_IdempotencyKey'
      AND object_id = OBJECT_ID(N'dbo.TblWhatsAppGatewayDelivery')
)
BEGIN
    ALTER TABLE [dbo].[TblWhatsAppGatewayDelivery]
        ADD CONSTRAINT [UQ_TblWhatsAppGatewayDelivery_IdempotencyKey] UNIQUE ([IdempotencyKey]);
    PRINT N'Created UQ_TblWhatsAppGatewayDelivery_IdempotencyKey';
END
ELSE
    PRINT N'UQ_TblWhatsAppGatewayDelivery_IdempotencyKey already present';
GO
