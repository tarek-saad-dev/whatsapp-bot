-- =============================================
-- SQL Server Trigger: Auto WhatsApp Notification
--   Sale / Booking / First-Time Customer
-- =============================================
-- Table: TblinvServDetail
-- Trigger: trg_TblinvServDetail_WhatsAppNotification
--
-- Logic (priority order):
--   1) Count previous invoices for same ClientID (from TblinvServHead)
--      → 0 previous = first_time
--   2) invType = N'حجز' → booking
--   3) Otherwise        → sale
--
--   Customer name still extracted from Notes (for message personalization)
--   Customer mobile from TblClient by Name
--   ClientID, ReservDate, ReservTime from TblinvServHead
--   Service name from TblPro.ProName via ProID
-- =============================================

CREATE OR ALTER TRIGGER trg_TblinvServDetail_WhatsAppNotification
ON [dbo].[TblinvServDetail]
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;

    ----------------------------------------------------------------
    -- 1) إعدادات الـ Endpoint بتاع الـ Node.js
    ----------------------------------------------------------------
    DECLARE @NodeJSEndpoint NVARCHAR(500) = 'http://localhost:3000/api/sales/notify';
    DECLARE @APIToken       NVARCHAR(100) = 'your-secret-token-change-this'; 
    -- لازم تكون نفس قيمة SQL_TRIGGER_TOKEN في ملف .env بتاع الـ Node

    ----------------------------------------------------------------
    -- 2) متغيّرات
    ----------------------------------------------------------------
    DECLARE @ID            INT;
    DECLARE @invID         INT;
    DECLARE @Notes         NVARCHAR(400);
    DECLARE @SValue        DECIMAL(18,2);
    DECLARE @invType       NVARCHAR(50);
    DECLARE @ProID         INT;

    DECLARE @ClientID       INT;
    DECLARE @PrevInvCount   INT;
    DECLARE @CustomerName   NVARCHAR(200);
    DECLARE @CustomerMobile NVARCHAR(20);

    DECLARE @ReservTime       NVARCHAR(50);
    DECLARE @ReservDate       NVARCHAR(50);
    DECLARE @ServiceName      NVARCHAR(200);
    DECLARE @NotificationType NVARCHAR(20);

    DECLARE @JSONBody     NVARCHAR(MAX);
    DECLARE @ResponseText NVARCHAR(MAX);
    DECLARE @ObjectToken  INT;
    DECLARE @HTTPStatus   INT;
    DECLARE @ErrorMessage NVARCHAR(MAX);

    ----------------------------------------------------------------
    -- 3) كيرسور على الصفوف اللي اتضافت في TblinvServDetail
    ----------------------------------------------------------------
    DECLARE detail_cursor CURSOR FOR
        SELECT ID, invID, Notes, SValue, invType, ProID
        FROM inserted;

    OPEN detail_cursor;
    FETCH NEXT FROM detail_cursor INTO @ID, @invID, @Notes, @SValue, @invType, @ProID;

    WHILE @@FETCH_STATUS = 0
    BEGIN
        ----------------------------------------------------------------
        -- 4) استخراج اسم العميل من الـ Notes
        --     مثال Notes:  N'مبيعات / حمزه فهد'
        --     هنمسك كل اللي بعد العلامة '/'
        ----------------------------------------------------------------
        IF (@Notes IS NULL OR LTRIM(RTRIM(@Notes)) = N'')
        BEGIN
            PRINT 'No Notes for ID=' + CAST(@ID AS NVARCHAR(10));
            GOTO FetchNextRow;
        END

        IF CHARINDEX(N'/', @Notes) > 0
        BEGIN
            SET @CustomerName = LTRIM(RTRIM(
                SUBSTRING(
                    @Notes,
                    CHARINDEX(N'/', @Notes) + 1,
                    LEN(@Notes)
                )
            ));
        END
        ELSE
        BEGIN
            SET @CustomerName = LTRIM(RTRIM(@Notes));
        END

        ----------------------------------------------------------------
        -- 5) نجيب رقم الموبايل من TblClient بالاسم
        ----------------------------------------------------------------
        SET @CustomerMobile = NULL;

        SELECT TOP 1 
            @CustomerMobile = Mobile
        FROM [dbo].[TblClient]
        WHERE LTRIM(RTRIM([Name])) = @CustomerName;

        IF (@CustomerMobile IS NULL OR LTRIM(RTRIM(@CustomerMobile)) = '')
        BEGIN
            PRINT N'No mobile found for customer name: ' + ISNULL(@CustomerName, N'NULL') 
                  + N' (ID=' + CAST(@ID AS NVARCHAR(10)) + N')';
            GOTO FetchNextRow;
        END

        ----------------------------------------------------------------
        -- 6) نجيب ClientID + ReservDate + ReservTime من TblinvServHead
        ----------------------------------------------------------------
        SET @ClientID = NULL;
        SET @ReservTime = NULL;
        SET @ReservDate = NULL;

        SELECT 
            @ClientID   = h.ClientID,
            @ReservTime = CAST(h.ReservTime AS NVARCHAR(50)),
            @ReservDate = FORMAT(h.ReservDate, 'yyyy-MM-dd')
        FROM [dbo].[TblinvServHead] h
        WHERE h.invID = @invID;

        ----------------------------------------------------------------
        -- 7) نعدّ الفواتير السابقة لنفس ClientID
        --    (نستبعد الفاتورة الحالية)
        ----------------------------------------------------------------
        SET @PrevInvCount = 0;

        IF @ClientID IS NOT NULL
        BEGIN
            SELECT @PrevInvCount = COUNT(*)
            FROM [dbo].[TblinvServHead]
            WHERE ClientID = @ClientID
              AND invID <> @invID;
        END

        ----------------------------------------------------------------
        -- 8) تحديد نوع الإشعار بالأولوية:
        --    first_time > booking > sale
        ----------------------------------------------------------------
        SET @ServiceName = NULL;
        SET @NotificationType = 'sale';  -- default

        IF @PrevInvCount = 0
        BEGIN
            -- عميل أول مرة (مفيش فواتير سابقة)
            SET @NotificationType = 'first_time';
        END
        ELSE IF (@invType IS NOT NULL AND LTRIM(RTRIM(@invType)) = N'حجز')
        BEGIN
            SET @NotificationType = 'booking';
        END

        -- نجيب اسم الخدمة من TblPro (مفيد للحجز وللعميل الجديد)
        IF @ProID IS NOT NULL
        BEGIN
            SELECT @ServiceName = ProName
            FROM [dbo].[TblPro]
            WHERE ProID = @ProID;
        END

        ----------------------------------------------------------------
        -- 9) تجهيز JSON يتبعت للـ Node.js
        --    هنبعت كل الداتا دايمًا، والـ Node هيستخدم اللي يحتاجه
        ----------------------------------------------------------------
        SET @JSONBody = (
            SELECT 
                @CustomerMobile         AS phone,
                @NotificationType       AS [type],
                @invID                  AS [saleData.orderId],
                CAST(ISNULL(@SValue, 0) AS NVARCHAR(20)) AS [saleData.amount],
                N'EGP'                  AS [saleData.currency],
                @CustomerName           AS [saleData.customerName],
                ISNULL(@ReservDate, '') AS [saleData.date],
                ISNULL(@ReservTime, '') AS [saleData.time],
                ISNULL(@ServiceName,'') AS [saleData.service]
            FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
        );

        ----------------------------------------------------------------
        -- 10) إرسال HTTP POST للـ Node.js API
        ----------------------------------------------------------------
        BEGIN TRY
            EXEC sp_OACreate 'MSXML2.ServerXMLHTTP', @ObjectToken OUT;

            EXEC sp_OAMethod @ObjectToken, 'Open', NULL, 'POST', @NodeJSEndpoint, 'false';
            EXEC sp_OAMethod @ObjectToken, 'setRequestHeader', NULL, 'Content-Type', 'application/json';
            EXEC sp_OAMethod @ObjectToken, 'setRequestHeader', NULL, 'X-API-Token',   @APIToken;

            EXEC sp_OAMethod @ObjectToken, 'send', NULL, @JSONBody;

            EXEC sp_OAGetProperty @ObjectToken, 'status',       @HTTPStatus OUT;
            EXEC sp_OAGetProperty @ObjectToken, 'responseText', @ResponseText OUT;

            IF @HTTPStatus = 200
            BEGIN
                PRINT N'WhatsApp (' + @NotificationType + N') sent for invID=' 
                      + CAST(@invID AS NVARCHAR(10)) 
                      + N', customer=' + @CustomerName
                      + N', ClientID=' + ISNULL(CAST(@ClientID AS NVARCHAR(10)), N'NULL')
                      + N', prevInvoices=' + CAST(@PrevInvCount AS NVARCHAR(10));
            END
            ELSE
            BEGIN
                PRINT N'Failed WhatsApp (' + @NotificationType + N') for invID=' 
                      + CAST(@invID AS NVARCHAR(10))
                      + N'. Status=' + CAST(@HTTPStatus AS NVARCHAR(10))
                      + N'. Response=' + ISNULL(@ResponseText, N'');
            END
        END TRY
        BEGIN CATCH
            SET @ErrorMessage = ERROR_MESSAGE();
            PRINT N'Error sending WhatsApp (' + @NotificationType + N') for invID=' 
                  + CAST(@invID AS NVARCHAR(10))
                  + N'. Error: ' + @ErrorMessage;
        END CATCH

        IF @ObjectToken IS NOT NULL
            EXEC sp_OADestroy @ObjectToken;

        ----------------------------------------------------------------
        -- 11) الصف اللي بعده
        ----------------------------------------------------------------
        FetchNextRow:
        FETCH NEXT FROM detail_cursor INTO @ID, @invID, @Notes, @SValue, @invType, @ProID;
    END

    CLOSE detail_cursor;
    DEALLOCATE detail_cursor;
END;

