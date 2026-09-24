# Runtime engine abstraction (design — not a global migration)

## Proven

| Engine | Cut Salon physical inbound |
|---|---|
| `BAILEYS_V6` (6.7.24) | FAIL — CIPHERTEXT / Message absent from node |
| `BAILEYS_V7` (7.0.0-rc14) | PASS — notify + plaintext_ok |

## Proposed SaaS field

`TblChannelConnection` (or managed-account registry) gains:

```
runtimeEngine: BAILEYS_V6 | BAILEYS_V7
```

Defaults:
- existing accounts → `BAILEYS_V6`
- Cut Salon (`wa_f09d54055f079b2624800b46`) → `BAILEYS_V7`

No automatic migration of the fleet.

## Process model

- Keep **process isolation** for v7.
- Preferred: one v7 worker process per account (or pool with exclusive auth ownership).
- Critical invariant: **one authDir → exactly one active Baileys owner**.
- Never run v6 + v7 against the same WhatsApp account simultaneously.

## Auth promotion

Reuse the paired canary auth only after:
1. canary process stopped cleanly
2. production v7 owner acquires exclusive ownership
3. same authDir or atomic migrated copy

Never copy auth while both processes are active.

## Crypto health telemetry (future)

Counters (per account):
- decryptFailureCount
- messageAbsentFromNodeCount
- plaintextInboundCount
- lastPlaintextInboundAt

States: `UNKNOWN` | `HEALTHY` | `DEGRADED_CRYPTO`

Do **not** auto-migrate on a single transient decrypt failure. Require multiple genuine live inbound failures with zero plaintext recovery.

## Explicit non-goals

- Global root Baileys dependency upgrade
- Automatic migration of all accounts to v7
- Dual ownership of one authDir
