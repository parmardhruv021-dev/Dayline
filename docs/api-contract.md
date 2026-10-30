# API contract

**Status:** Proposed contract partially implemented; available endpoints appear in the server and automated HTTP tests. Invitation/recovery, full org/member administration and several planned routes are absent. API prefix `/api/v1`. JSON requests/responses use ISO-8601 UTC timestamps and opaque IDs. Current routes require authenticated membership except sign-in, health and static assets. Every protected endpoint derives actor and organization from the verified session; tenant identifiers in a request are never sufficient authority.

## Common contract

- Request: `Content-Type: application/json`; mutating requests require same-origin `Origin`/CSRF defense and an `Idempotency-Key` for event-producing operations.
- Success: `{ "data": ..., "requestId": "..." }`; list endpoints add `{ "page", "pageSize", "total" }`.
- Error: `{ "error": { "code": "...", "message": "...", "fieldErrors"?: ..., "requestId": "..." } }`; never leak SQL/stack or cross-tenant existence.
- Status: 400 validation, 401 unauthenticated, 403 unauthorized, 404 absent/out-of-scope (consistent anti-enumeration policy), 409 invalid/concurrent state, 422 policy-invalid transition, 429 sensitive endpoint throttled, 500 opaque internal error.
- Rate limits for sign-in, invitation/recovery, and export; audit privileged mutations. Paginate/search large directories.

## Authentication and membership

| Method / route | Purpose and authorization |
|---|---|
| `POST /auth/login` | Verify normalized email and scrypt hash; generic failure; create opaque hashed server session cookie. Rate-limited. |
| `POST /auth/logout` | Revoke current session and expire cookie. |
| `GET /auth/me` | Return user and memberships/roles available to the user. |
| `POST /auth/recovery-requests` | Only when email delivery is configured; uniform response, single-use short-lived hashed token. If disabled, return explicit configuration error, never fake a sent email. |
| `POST /invitations` | Admin creates scoped invitation; actual email delivery requires configured adapter. |
| `POST /invitations/accept` | Validate single-use token, expiry, identity and password requirements; transactionally activate membership. |

## Core attendance

| Method / route | Purpose / state rule |
|---|---|
| `GET /me/attendance/current` | Return current session/break, server `now`, and today's derived totals in org timezone. |
| `POST /me/attendance/clock-in` | Idempotent; server validates membership/policy, timestamps and creates event/session transactionally. Client cannot set actor/time. |
| `POST /me/attendance/clock-out` | Idempotent; closes only caller's active session. |
| `POST /me/attendance/breaks/start` | Requires caller's active session and no open break; organization policy supplies the paid flag (unpaid by default); request payload cannot override it. |
| `POST /me/attendance/breaks/end` | Requires matching open break; interval retains the compensation policy captured at its start. |
| `GET /me/timesheets?from=&to=&timezone=` | Own entries and totals; date ranges are half-open and validated. |
| `POST /me/corrections` | Create request with reason/proposal; cannot directly alter event. |
| `GET /me/corrections` | Own request status/history. |

## Screen snapshots

| Method / route | Purpose / state rule |
|---|---|
| `GET /snapshots/config` | Returns the organization snapshot policy (enabled, interval bounds, retention) plus, for an open session, the server-derived first due time and current capture state. |
| `POST /attendance/snapshots` | Requires an enabled policy, the caller's open session and no open break. Accepts one JPEG/PNG/WebP frame up to 384 KB (or a `capture_unavailable` marker recorded at most once per session). The server stores the frame, prunes frames past retention, and returns the next due time chosen randomly inside the configured interval; a repeat before that time returns 429 `SNAPSHOT_TOO_SOON`. |
| `GET /attendance/snapshots?sessionId=&membershipId=` | Own snapshot metadata; managers/admins may pass a member they are authorized to manage (otherwise 403/404). Never returns image bytes. |
| `GET /snapshots/{id}/image` | Serves stored bytes for the owner or an authorized manager/admin; anyone else receives 404. `Cache-Control: private`. |

## Organization policy

- `GET /organization/policies` returns break and snapshot policy. `PATCH /organization/policies` is admin-only and updates `breaksPaid` and/or `snapshotsEnabled`, `snapshotMinIntervalSeconds`, `snapshotMaxIntervalSeconds`, `snapshotRetentionDays` (bounds 30–7200 seconds, min ≤ max, retention 1–365 days). Break default is unpaid; snapshot default is disabled. Every update creates an audit event; existing break/snapshot rows are not rewritten.

## Manager/admin routes

- `GET /teams/{teamId}/attendance?date=` manager must be assigned; admin may access org scope.
- `GET /timesheets?teamId=&from=&to=&state=` filters only after server authorization; managers restricted to assigned teams.
- `POST /timesheets/{id}/submit`, `/approve`, `/reject`, `/reopen` require valid state and appropriate role/scope; submit is refused when the employee has an active session overlapping that timesheet's local-date range; reject/reopen require a reason.
- `GET /corrections?state=`; `POST /corrections/{id}/approve|reject|clarify` requires assigned approver and records decision/adjustment transactionally.
- `GET|POST /employees`, `PATCH /employees/{id}`, `POST /employees/{id}/deactivate` are admin-only; manager edits require explicit field permission.
- `GET|POST /settings`, `/teams`, `/schedules`, `/leave`, `/projects` are role and module scoped; phase availability is recorded in the feature matrix.
- `GET /reports/attendance?from=&to=&teamId=&projectId=&timezone=` returns authorized aggregates. `GET /reports/attendance.csv?...` streams RFC 4180-compatible escaped CSV with formula-injection protection and same query scope.
- `GET /audit?from=&to=&actorId=&subject=` returns only authorized history.

## Health and operational endpoints

`GET /health/live` checks process only; `GET /health/ready` verifies migration state and DB read. Do not return configuration secrets or sensitive database diagnostics.

## Contract invariants

- List/detail/report endpoints enforce tenant scope in repository queries as well as route authorization.
- All state changes return persisted representation and audit/request IDs.
- Replayed idempotency key with same operation returns original result; key reuse for a different payload returns conflict.
- Clock and approval decisions use server time; caller-provided time can appear only in an explicitly submitted correction proposal, never as a raw event timestamp.
