# Baileys v7 Cut Salon Canary (EXPERIMENT ONLY)

Isolated Node process to test whether **Baileys `7.0.0-rc14`** can decrypt physical inbound for Cut Salon (`01012126899`) where production Baileys `6.7.24` receives only `messageStubType=2` / CIPHERTEXT.

## Hard rules

- Does **not** touch production `whatsapp-bot` Baileys dependency
- Separate auth dir: `/home/whatsapp/canary-auth/cut-salon-v7/`
- Separate systemd unit: `whatsapp-cut-v7-canary.service`
- No outbound send, no AI, no SaaS delivery in Phase A
- No shared memory / auth with `whatsapp-bot.service`

## Pin

```
@whiskeysockets/baileys@7.0.0-rc14
```

Exact pin (no `^` / `~`).

## Auth note (experiment vs production)

This canary uses `useMultiFileAuthState` for a short-lived protocol test only.

Baileys v7 docs still recommend multi-file as a **guide**, and advise production systems use SQL/NoSQL key stores with careful `keys.set()` handling (optionally wrapped in `makeCacheableSignalKeyStore`). Do **not** treat this canary auth as the final SaaS architecture.

## Local

```bash
cd experiments/baileys-v7-cut-canary
npm ci
CANARY_AUTH_DIR=./.tmp-auth CANARY_HTTP_PORT=3017 npm start
```

Status: `GET http://127.0.0.1:3017/status`  
QR PNG: `GET http://127.0.0.1:3017/qr.png`

## Tests

```bash
npm test
```
