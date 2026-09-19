# Phase 3B — Dependency Security Audit

Date: 2026-09-19  
Repo: `whatsapp-bot`  
Scope: report findings; apply only safe, low-risk upgrades that install cleanly.

## Summary

`npm audit` reports multiple advisories. Attempted safe bumps (`express@^4.22.3`, `vitest@^4.1.11`) failed locally with npm `Cannot read properties of null (reading 'edgesOut')` during `npm install`, so **no lockfile / dependency tree changes were committed** in this milestone. Revisit when npm install is healthy.

## Findings (current tree)

| Package | Severity | Notes | Action this milestone |
|---|---|---|---|
| `vitest` / `@vitest/mocker` / `@vitest/coverage-v8` (≤4.1.10) | moderate | Path traversal in mocker; fix in ≥4.1.11 | Deferred — install tooling failed |
| `express` / `body-parser` / `qs` / `path-to-regexp` | moderate–high | Express 4.22.3+ addresses several | Deferred — install tooling failed |
| `adm-zip` (via `pkg`) | high | Transitive of `pkg` | Deferred — `pkg` is build-only; runtime not affected |
| `jws` | high | Transitive | Deferred — confirm consumer; avoid major bumps |
| `nanoid` | high | Transitive | Deferred |
| `picomatch` | high | Transitive (tooling) | Deferred |
| `postcss` | high | Transitive (tooling) | Deferred |
| `pkg` | moderate | **No fix available** (GHSA-22r3-9w55-cj54) | Accepted risk — packaging only, not production server runtime |

## Explicit non-goals

- No major upgrades (`express@5`, `vitest@5`, Baileys major).
- No `npm audit fix --force`.
- No changes to auth/env/schema as part of audit.

## Recommended follow-up (separate PR)

1. Repair npm install (clear corrupt cache / regenerate lockfile on a clean machine).
2. Bump `vitest` + `@vitest/coverage-v8` to `^4.1.11` (dev-only).
3. Bump `express` to `^4.22.3` and re-run `npm test` + a smoke send/status check.
4. Re-evaluate `pkg` usage or pin/replace if EXE builds remain required.
5. Re-run `npm audit` and update this document.

## Runtime posture

Production server path depends primarily on Express + Baileys + Selenium/chromedriver. Highest priority post-tooling fix: **Express 4.22.3 patch line**. Dev-only vitest issues are lower urgency for production exposure.
