# Deployment and local setup

**Status:** Local implementation commands are available and were verified for the seed/migration and focused tests. Production has not been deployed or security-reviewed. The app uses Node.js built-in SQLite and is intended initially for one persistent host only.

## Requirements

- Node.js 24.15 or later (tested with 24.22.0).
- No npm dependencies are currently required.
- A writable durable local filesystem for SQLite. Do not place the DB on an unverified network share or run multiple hosts against one SQLite file.

## First-time setup

```bash
cp .env.example .env
# Set SESSION_SECRET to at least 32 random bytes.
# Example: openssl rand -base64 48
# Keep .env private; it is gitignored.
npm run migrate
node src/provision.mjs admin@example.com "Office Admin" "Your Organization" "A-long-unique-password!"
npm start
```

Open `http://127.0.0.1:3000`. The `.env.example` defaults bind to loopback, point at `./data/dayline.sqlite`, and leave demo login off. `SESSION_SECRET` has no committed default; the server refuses to start without at least 32 characters. For the local demo, run `npm run seed` with `NODE_ENV=development`, then opt in to `ALLOW_DEMO_LOGIN=true`; do not use demo accounts/passwords in production.

## Development and tests

```bash
npm run dev
npm test
```

Use a separate test database if setting `DATABASE_PATH`. Migrations apply transactionally at process startup and are safe to re-run. `npm run migrate` prints the applied schema versions. `npm run seed` refuses outside development and creates fictional sample accounts/records.

## Production boundary

- Set `NODE_ENV=production`, `SESSION_SECRET` to a high-entropy deployment secret, `COOKIE_SECURE=true`, `HOST=127.0.0.1` behind a local TLS reverse proxy (or a deployment-specific trusted interface), and `DATABASE_PATH` to a durable, permission-restricted path.
- Do not expose Node directly to an untrusted network without TLS termination, firewalling and operational request limits.
- Use a reverse proxy with a configured trusted host/origin, TLS and secure headers. The current app trusts the request Host only for same-origin comparison; add explicit configured-origin validation before internet-facing operation.
- Do not enable `ALLOW_DEMO_LOGIN`, seed production, or copy the demo password into a production account.
- Invitations, password recovery/email delivery, account recovery, bulk employee administration and organizational settings UI are not implemented. Provision additional employees/managers through a controlled future admin operation, not direct ad hoc SQL in production.

## Database backup, restore and migration

Before upgrade, stop writes or take a consistent SQLite backup using SQLite's backup API. Do not copy only a live main DB file while WAL may contain committed pages. Restrict and encrypt backups, set an explicit retention period, and rehearse restore into an isolated DB. Run `PRAGMA integrity_check; PRAGMA foreign_key_check;` after restore. Migration rollback must not discard attendance; prefer additive forward repair. No backup tool/restore drill has yet been implemented or tested.

## Health, logs and rollback

`GET /health/live` and `/health/ready` expose process/database readiness only. Server logs include request IDs for internal errors; avoid adding employee details, credentials or session tokens. Deploy an immutable application revision, back up before migration and retain a known-good previous artifact. No CI, dependency audit, production build bundler or production deployment is configured yet; the application is plain Node ESM source served directly.
