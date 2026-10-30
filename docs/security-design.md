# Security and privacy design

**Status:** Design plus a partial implementation. Server-side scrypt password verification, hashed opaque sessions, secure production cookie requirements, origin comparison for mutations, tenant-scoped queries, audit records, and input-size checks exist. Rate limiting, invitation/recovery, proxy-origin allowlisting, broader threat tests, and production security review remain outstanding. Attendance data is sensitive employee information. This document is not legal advice.

## Identity and session security

- Hash passwords using Node `crypto.scrypt` with per-password random salt and parameterized cost; use constant-time verification and rehash on policy upgrades.
- Generate cryptographically random opaque session tokens; store only a keyed/hash representation in SQLite; set cookies `HttpOnly`, `Secure` in production, `SameSite=Lax` or stricter as compatible, restricted `Path`, and bounded expiry. Rotate after authentication/privilege change; revoke on logout/deactivation/password change.
- Generic login/recovery errors avoid account enumeration; rate-limit by account and source; require TLS at deployment. Recovery uses short-lived one-time tokens stored hashed and only works with a configured mail adapter.
- Bootstrap first admin through a documented one-time CLI/environment secret, not a public unauthenticated registration endpoint. Disable/remove bootstrap path after initialization.

## Authorization and tenant isolation

- Session -> user -> active organization membership is resolved on every request. Active org context must be selected from server-verified memberships.
- Central permission functions accept actor, target, action and current team/organization assignments. Recheck in each service; never trust hidden controls, client role claims, employee IDs, approval decisions or timestamps.
- Use repository methods requiring `organizationId` in their arguments; all SQL binds parameters and includes tenant predicates. Composite FKs constrain tenant relationships.
- Managers are limited to assigned teams and explicit operations; employee self-service is limited to own records; admin scope is one organization. Do not assume an admin in one organization is global admin.
- Avoid revealing whether out-of-scope IDs exist. Test horizontal escalation for both read and write, including CSV exports and audit endpoints.

## Request, output, and operational protections

- Same-origin/CSRF validation on mutation; do not enable wildcard CORS. Validate every body/query/path with shared schema. Parameterized SQL. Escape rendered text; use safe React text nodes and restrictive CSP/security headers.
- CSRF tokens if cookie policy or cross-origin deployment requires them; origin/referer check is not the only control if deployment architecture changes.
- Request size limits, rate limits, timeouts, safe pagination, audit correlation IDs, no credential/token/time-entry payload logging. Redact PII from errors.
- CSV quoting plus spreadsheet-formula prefix neutralization for user-controlled cells; exports scope and audit, and responses use attachment/no-sniff/private cache controls.
- Secure environment secrets outside repository; restrictive SQLite file/directory permissions; TLS proxy; patch dependencies; encrypted off-host backups and documented restore test.

## Auditability and attendance integrity

- Immutable raw attendance events and append-only adjustments; prevent regular application code from overwriting history. Audit clock, correction, approval, role, setting, invite/deactivate operations with actor, target, time, reason and changed fields.
- Commit audit record in same transaction as consequential mutation. Audit views are permission-scoped; retention and employee deletion/anonymization require an explicit policy.
- Idempotency + unique DB constraints + serialized transactions protect duplicate and concurrent punches. Server owns timestamps and state.

## Privacy limits

P0 does not collect GPS, biometrics, face images, continuous location, or keystroke/activity surveillance. If such verification is later proposed, require documented purpose, consent/legal basis, minimization/retention/access disclosure, security review and jurisdictional legal review. Do not classify an employee as fraudulent from weak anomaly signals.

## Threat tests required before P0 completion

- Employee guesses another employee/session/time entry ID; request denied without data leak.
- Manager queries an unassigned team; denied in API and export.
- Organization A member changes org/record IDs to read/write organization B; denied.
- Duplicate/replayed request and two simultaneous clock-ins; one canonical session/event.
- CSRF/cross-origin mutation, expired/revoked session, brute force, invalid input, XSS payload in names/reasons, CSV formula payload.
- Concurrent approval/reopen/correction attempts preserve valid state and complete audit.

No tests have been executed yet; results belong in [test-report.md](test-report.md).
