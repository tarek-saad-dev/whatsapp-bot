# Phase 3B — Operations & Recovery

Managed Baileys outbound hardening runbook for `whatsapp-bot`.
Status fields below are safe for operators (no phones, bodies, keys, or secrets).

## Managed account `getStatus()` shape (when available)

```json
{
  "idempotency": {
    "total": 0,
    "sending": 0,
    "sent": 0,
    "saturated": false
  },
  "outboundObservation": {
    "pending": 0,
    "unresolved": 0,
    "failed": 0,
    "delivered": 0,
    "oldestUnresolvedCapturedAt": null,
    "unresolvedSaturated": false
  },
  "numberSafety": {
    "state": "NORMAL",
    "cooldownUntil": null,
    "minuteCount": 0,
    "hourCount": 0,
    "dayCount": 0
  }
}
```

Never expose: phone numbers, message bodies, payload hashes, idempotency keys, auth data, secrets.

---

## Safety invariants (do not violate)

1. Never auto-resend when the WhatsApp send outcome is ambiguous (`SENDING` / `OUTBOUND_RESULT_UNKNOWN`).
2. Never silently prune `SENDING` idempotency rows.
3. Never invent `HUMAN` from uncertainty; only promote when observation is decisive.
4. Never downgrade a `DRVOWA_API` origin to something weaker.
5. Observation / S2S delivery failure must not fail the WhatsApp send path.

---

## Outbound observation delivery classification

| HTTP / error | Behavior |
|---|---|
| 400 / 401 / 403 | Permanent failure immediately → `FAILED` |
| 404 | Soft retry with backoff; permanent only after **3 consecutive** HTTP 404s |
| 408 / 429 / 5xx / network / timeout | Transient retry |
| Global max attempts exhausted | `FAILED` |
| `UNRESOLVED` origin | Held outside delivery/retry until promoted by a decisive local event |

### Operator actions — observation spool

- **Rising `unresolved` / `oldestUnresolvedCapturedAt` aging:** check Baileys events and text-match promotion; do not manually invent HUMAN.
- **`unresolvedSaturated: true`:** spool hit unresolved capacity — investigate stuck UNRESOLVED rows; restart alone will not clear them (durable).
- **Persistent 404 → `failed`:** usually deploy/version mismatch on the autoresponse inbound observation route. Fix the API route, then allow new captures; do not force-resend WhatsApp.
- **401/403:** fix S2S auth / runtime secret alignment; records already permanent-failed stay failed.

---

## Idempotency store recovery

| Signal | Meaning | Action |
|---|---|---|
| `sending` > 0 after crash | Ambiguous in-flight sends preserved | Do **not** clear; wait for operator/process policy. Retrying the same key returns `OUTBOUND_RESULT_UNKNOWN` (409). |
| `saturated: true` | Unresolved `SENDING` filled capacity | New keys rejected with `OUTBOUND_IDEMPOTENCY_CAPACITY` (503). Resolve stuck SENDING via documented ops only — never mass-delete. |
| Duplicate key after `SENT` | Safe replay | Returns prior `messageId`; does not re-send WhatsApp and does not consume number-safety quota. |

Atomic persistence (`tmp` → fsync → rename → best-effort dir fsync) keeps the last committed JSON valid if a write step fails.

---

## Number safety recovery

| `numberSafety.state` | Meaning |
|---|---|
| `NORMAL` / `CAUTION` | Admitting new sends (caution is soft signal only) |
| `COOLDOWN` | New sends rejected with `OUTBOUND_NUMBER_SAFETY` (429) until `cooldownUntil` |
| `PAUSED` | Hard pause for this account provider instance |

Counters are per managed account lifecycle. Account A never shares state with Account B.
SENT duplicate replay and SENDING unknown paths skip safety admission.

**Customer-initiated prioritization:** not implemented at this layer — the runtime does not have reliable inbound-recency context here. Future hook: inject an optional `checkInboundHook` into `createOutboundNumberSafety` when conversation context is available upstream.

---

## M3 blocker — AI auto-reply job drain (cross-repo)

**Blocked in this repository.** The AI worker that drains outbound auto-reply jobs lives in **`drvowa-autoresponse`** (`scripts/ai-worker.ts` and related modules), not in `whatsapp-bot`.

WhatsApp-bot Phase 3B delivers:

- Observation spool + worker (ORIGIN/STATUS including UNRESOLVED)
- Idempotency + atomic durability
- Number safety + status aggregation

**Continue independently** in `drvowa-autoresponse` for:

1. Job drain / retry for AI outbound jobs
2. Pause/resume conversation AI controls
3. End-to-end observation ACK from the Next.js runtime routes

Until that work lands, treat observation delivery failures as S2S/runtime issues (this runbook), not as WhatsApp send failures.

---

## Restart expectations

After process restart:

- Idempotency file and observation spool reload from disk (last-known-good).
- Number-safety counters reset (in-memory for provider lifetime only) — expected.
- Inbound delivery worker and outbound observation worker restart with the provider.

---

## Quick triage checklist

1. WhatsApp `READY`? If `LOGGED_OUT`, reconnect / re-auth — do not spam reconnect.
2. `idempotency.sending` stuck? Preserve; do not auto-resend.
3. `outboundObservation.failed` climbing after 404×3? Fix autoresponse route version.
4. `numberSafety` in `COOLDOWN`? Wait for `cooldownUntil` or inspect burst/fan-out causes.
5. Need AI job drain health? Check **drvowa-autoresponse** worker, not this process.
