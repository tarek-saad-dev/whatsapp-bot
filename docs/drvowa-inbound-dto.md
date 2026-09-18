# DRVOWA inbound transport DTO (Phase 2A)

Transport callback payload for managed WhatsApp accounts.

Production delivery to DRVOWA SaaS is **not enabled** in Phase 2A.

```json
{
  "accountKey": "cut-salon",
  "provider": "baileys",
  "providerMessageId": "ABCDEF123",
  "externalContactKey": "2015XXXXXXXX",
  "fromMe": false,
  "isGroup": false,
  "messageTimestamp": 1710000000,
  "receivedAt": "2026-09-18T00:00:00.000Z",
  "upsertType": "notify",
  "content": "message text or structured content"
}
```

Rules:

- `accountKey` comes from trusted runtime state (never from WhatsApp payload alone).
- No `BusinessID` — SaaS maps `accountKey` → business.
- Only live `notify` upserts are treated as inbound (append/history ignored).
