# Independence audit

**Audit date:** 2026-10-27  
**Current status:** An initial app implementation and HTTP tests exist, but independence is not yet demonstrated as a production deployment; this audit distinguishes implemented local dependencies from deferred deployment proofs.

## Intended dependency inventory

| Dependency | Purpose | Required for core clocking? | Current state |
|---|---|---:|---|
| Node.js runtime | Host application | Yes | Present locally (v24.22.0); app runs from source. |
| SQLite library/database | Durable tenant/attendance persistence | Yes | Node 24 `node:sqlite` binding used; migrated/tested on one local file. Single-host only. |
| Jibble | Reference material only | No | Public product/docs researched; no runtime/API dependency intended. |
| Email provider | Invitations and password reset delivery | No for clocking; yes for production email flows | Not selected/configured; do not claim invitations/reset are deliverable until implemented. |
| Hosting/TLS proxy | Public production access | No for local core; yes for network deployment | Not selected; no deployment requested/performed. |
| Test/browser runner | Automated verification | No runtime dependency | Built-in `node:test` used for unit/integration tests. Browser E2E runner and visual browser checks unavailable/not run. |

## Required proof before independence can be claimed

- App starts from a documented fresh checkout without contacting Jibble.
- Database is created from versioned migrations, not copied live data.
- Clock-in/out/break works with only the app and its own DB.
- No required API request, login, data store, asset, or secret belongs to Jibble.
- Optional mail/integration adapters can be disabled without preventing clocking.
- Seed data runs explicitly only for development/test; production dashboards derive solely from persisted tenant records.
- Export, session auth and permissions function locally and in documented self-host deployment.
- Backup/restore and fresh-environment smoke tests pass.

Locally verified: schema/migration and SQLite integrity; basic attendance persistence; an HTTP integration journey for sign-in, clock/break transitions, correction approval, timesheet approval and CSV data; app modules use no remote Jibble/API/data dependency. Not verified: fresh checkout startup without pre-existing local tooling, production backup/restore, internet-facing deployment, multi-host operation, browser-based flows, and complete auth/security review. The public sources used for research are linked in [product-research.md](product-research.md); source consultation does not create a product dependency.
