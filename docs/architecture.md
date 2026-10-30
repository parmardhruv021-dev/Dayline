# Architecture

**Status:** Current implementation architecture for the review milestone; this is not approval to expand into the full workforce application. Feature and deployment gaps are tracked in [implementation-plan.md](implementation-plan.md) and [test-report.md](test-report.md). Internal codename **Dayline** is configurable and not a final brand. Reference evidence and design choices are separated in [product-research.md](product-research.md).

## Actual application stack (reviewed 2026-10-28)

- Node.js 24 ESM server using built-in `node:http` and native `node:sqlite`; static HTML/CSS and browser-native JavaScript frontend. No TypeScript, React, Vite, ORM, or npm runtime dependencies are present.
- One deployable Node HTTP application: static client plus versioned JSON API. Attendance calculations live in `src/time.mjs` and `src/attendance.mjs`; route/session orchestration is in `src/app.mjs`; migrations are plain SQL.
- SQLite in WAL mode for an initial small-office, single-host deployment; explicit SQL migrations and parameterized queries. Require a persistent local volume, encrypted/off-host backups, and one application writer boundary. Multi-replica/large write throughput is not supported; reassess PostgreSQL before that scale.
- Opaque random server-side sessions stored as token hashes in SQLite; password hashes use Node's built-in scrypt. No external auth provider is required for core clocking.
- Request validation and authorization are currently hand-coded at HTTP boundaries; error responses use a stable code/message/request-id envelope. Rate limiting and recovery are not implemented yet.
- Tests use the built-in `node:test` runner and spawn an HTTP server for integration coverage. Browser E2E tooling is not installed.

This is the implementation currently in the workspace, not a future stack proposal. It remains independently runnable without Jibble, a hosted database, or external auth. SQLite selection is a deliberate initial tradeoff, not a claim that SQLite fits every production deployment.

## Runtime boundaries

1. **HTTP/API:** route authentication, same-origin checks for mutations, input validation, tenant context, permission check, response mapping. Rate limiting is a known gap.
2. **Application services:** transactional clock state machine, corrections, approvals, reports and policy validation; no request body may choose the authenticated actor, organization, timestamp or approval authority.
3. **Domain:** pure interval/payable-time calculations and explicit state transitions; no UI or SQL dependency.
4. **Repositories:** organization-scoped SQL; row mapping and safe transaction wrapper.
5. **Persistence:** versioned SQLite schema; database constraints for ownership/references and one active session/one open break where applicable. Organization break compensation policy defaults to unpaid and is snapshotted into each break when it starts.
6. **Frontend:** employee, manager and admin routes; derive display timer from persisted session data; UI visibility is not authorization.

## Current code boundaries and planned modules

Implemented code is currently organized into `src/app.mjs` (HTTP routes, sessions, authorization and API responses), `src/attendance.mjs` (transactional clock/break state transitions and attendance reads), `src/snapshots.mjs` (screen-snapshot policy, capture recording with server-issued random due times, scoped listing and retention pruning), `src/time.mjs` (date/time calculations), `src/db.mjs` (SQLite connection, migrations, transaction and audit helpers), `public/` (browser UI), and SQL migrations. Corrections, timesheet workflows, reports and policy routes currently live in the central HTTP module rather than separate domain modules.

The longer-term module boundaries are `auth`, `organizations`, `memberships`, `teams`, `attendance/events`, `sessions/breaks`, `corrections`, `timesheets`, `approvals`, `schedules`, `leave`, `projects/activities`, `reports/exports`, `notifications`, `audit`, and `settings`. Schedules, leave, projects, notifications and full administration are not implemented. Modular extraction is a future architecture step and should not be confused with current code structure.

## Screen snapshots (added after owner review)

Snapshots are disabled by default and are an explicit organizational choice, not a silent default. While an employee is clocked in and not on a break, the browser requests screen-share permission once per clocked-in session and captures a downscaled JPEG frame at times chosen by the server: the first due time is derived deterministically from the session id, and every later due time is returned randomly inside the admin-configured interval. The server refuses early repeats (429), frames while disabled/on break/after clock-out, and enforces size and type limits. The employee always sees a live capture indicator with the next due time and can decline permission; a declined capture is recorded honestly as `capture_unavailable` rather than silently skipped. Managers/admins can browse frames only for members they are authorized to manage; all other reads return 404. Frames are pruned after the configured retention period. This is browser-tab capture, not operating-system-level surveillance; no frame is captured without the browser permission grant, and capture pauses during breaks and stops at clock-out.

## System qualities

- All event timestamps are server-authored UTC instants; retain source time zone separately for business-date calculations.
- Critical mutations use one SQLite transaction (`BEGIN IMMEDIATE` where serialization is required), unique idempotency keys and constraints. Preserve raw events; corrections are new records.
- Organizations are first-class tenant boundaries. Every query includes organization scope sourced from a verified membership, not a client-supplied organization ID alone.
- Exports query the same authorized source records as the UI and protect spreadsheet consumers from formula injection.
- Consequential operations write audit data in the same transaction as the operation.
- No third-party integration is required for clocking. Optional delivery/integration adapters are separately configured and fail without breaking attendance.

## Deployment model and limits

Self-host the Node app on a supported persistent server or container with a durable encrypted SQLite volume, TLS reverse proxy, restricted filesystem permissions, backups and restore drills. SQLite WAL does not make a network filesystem or multi-host shared database safe. A future PostgreSQL migration would require a deliberate adapter/migration plan and concurrency tests; do not silently add app replicas over a single SQLite file.

## Decisions still open

Office jurisdiction/payroll policy, company timezone and pay-period, schedule rules, whether newly started breaks should be paid or unpaid, invite/recovery email provider, production hosting, backup retention and initial admin provisioning. The break default is currently unpaid but is an operational default, not a legal conclusion; admins can configure it and each started break retains its chosen policy. Other calculations are not payroll/legal advice.
