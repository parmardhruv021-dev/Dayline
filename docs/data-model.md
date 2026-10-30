# Data model and integrity

**Status:** Proposed initial schema is implemented in [`001_initial.sql`](../migrations/001_initial.sql) and migrated in tests. Some P1 entities (schedules, holidays, leave, projects, notifications) remain deferred. Use UUID/opaque IDs, UTC instants in ISO-8601 with millisecond precision, integer durations in milliseconds/seconds, integer booleans, foreign keys enabled, and explicit schema migrations. SQLite will be single-host for the initial deployment.

## Core entities

| Entity | Key fields / relationships | Integrity and lifecycle |
|---|---|---|
| `organizations` | id, name, timezone (IANA), week_start, breaks_paid boolean (default false), snapshots_enabled (default false), snapshot_min/max_interval_s (30–7200, default 180/480), snapshot_retention_days (default 30), created_at | Break policy changes are audited; a break interval snapshots `paid` at start so later configuration changes do not rewrite history. Snapshot policy changes are audited; policy is read on each capture so a change takes effect immediately without rewriting stored frames. Pay-period policy/version is planned but not yet implemented. |
| `users` | id, email normalized unique, password_hash, name, status, created_at | Global login identity; password never stored plaintext. |
| `memberships` | id, organization_id, user_id, role (`employee`,`manager`,`admin`), status, manager/team links | UNIQUE(org,user); all tenant data joins through membership. Deactivate, never cascade attendance. |
| `teams` | id, organization_id, name, archived_at | Scoped name uniqueness; membership assignment relationship has effective dates. |
| `sessions` | id, organization_id, employee_membership_id, started_at, ended_at nullable, source event IDs, project/activity refs nullable | CHECK ended_at > started_at; partial unique index for one open session per employee/org; FK `RESTRICT` for historical refs. |
| `attendance_events` | id, org, membership, session, kind (`clock_in`,`clock_out`,`break_start`,`break_end`), occurred_at, recorded_at, actor membership, idempotency key, source, metadata JSON | Append-only source of truth; UNIQUE(org,actor,idempotency_key); unique state constraints through transaction/domain, original actor/time preserved. |
| `break_intervals` (table `breaks`) | id, org, session_id, paid boolean, start/end timestamps | Partial unique open interval per session; compensation policy is read server-side from organization settings and snapshotted on insert; no overlaps checked transactionally. |
| `correction_requests` | id, org, target membership, requester, date/session, proposed payload, reason, status, resolver, timestamps | Allowed state transitions only; request cannot mutate events. No self-approval. |
| `time_adjustments` | id, org, target membership, source event/session, approved request, before/after JSON, reason, actor, created_at | Immutable append-only approved adjustments, FK restrict; calculated totals apply adjustments deterministically. |
| `timesheets` | id, org, membership, period start/end local dates, timezone, policy version, state, submitted/approved timestamps | UNIQUE(org,membership,period); states explicit; approved periods locked except audited reopen. |
| `approval_records` | id, org, timesheet/correction, approver membership, decision, reason, at | Immutable decisions; approver scope checked in service; no self-approval. |
| `work_snapshots` | id, org, membership, session, status (`captured`/`capture_unavailable`), captured_at, next_due_at, image BLOB nullable, content_type, width, height, bytes | One frame per row, tied to the capturing session; CHECK pairs status with image presence and requires `next_due_at > captured_at`; partial enforcement of the randomized schedule happens in the capture service (429 before due time); rows older than `snapshot_retention_days` are pruned on capture; reads restricted to owner and authorized manager/admin. |
| `work_schedules` / `schedule_assignments` | org, template/version, local days/intervals, breaks, effective dates, assigned member/team | No implicit legal schedule; effective-date overlap constraints and local-zone semantics. P1. |
| `holidays` | org, local date, name/location scope | unique per org/location/date; explicit year records. P1. |
| `leave_types` / `leave_requests` | org, paid flag, optional accrual policy; request member, date interval, reason/status/approver | Accrual requires explicit configured policy; overlap checked; P1. |
| `projects` / `activities` | org, name/status; session references | Archive rather than delete where historic sessions refer. P1. |
| `notifications` | org, recipient membership, event key, type, payload, read_at | Unique dedupe key per recipient; only emitted from persisted operation. |
| `audit_events` | org, actor membership, action, subject type/id, reason, before/after summary, request id, occurred_at | Insert in same transaction; prevent normal app updates/deletes; scope reads by role/team/self. |
| `sessions_auth` | token_hash, user_id, created_at, expires_at, last_seen_at, revoked_at | Store only hash of high-entropy cookie token; expiry/index/revoke. |
| `invitations` | org, normalized email, token_hash, role, expiry, accepted_at, inviter | Single-use hash token; expires; email delivery not assumed. |

## Relationships and enforcement

- Every organization-owned table includes `organization_id` and composite foreign keys where practical, so a row cannot point to a membership/session from another tenant.
- Turn SQLite foreign-key enforcement on for every connection. Add indexes beginning with `organization_id`, then queried membership/date/state columns.
- Use `ON DELETE RESTRICT` for event/session history, `SET NULL` only where a user identity can be anonymized without losing audit attribution policy; prefer deactivation/anonymization over deletion.
- Use a partial unique index for open session and open break; use serialized transaction and state validation to prevent illegal transitions.
- Actor and target are separate columns for manager/admin actions. Permission is checked against server-derived membership and assignments within the same operation.
- Raw events stay immutable. A view/service computes effective time as raw events plus approved adjustment records, preserving traceability.
- Local business date is calculated from UTC instants and effective IANA zone, not stored by trusting the client. A reporting snapshot may persist timezone and policy version for a submitted timesheet.

## Time semantics

Store exact UTC instants and keep organization/member time zone as an IANA identifier. Represent schedules and pay periods in local dates/time intervals plus zone. Cross-midnight intervals split by local day. DST transitions need deterministic tests: nonexistent local schedule times require explicit policy; repeated times require a defined earlier/later offset rule. Do not round event timestamps or intermediate intervals. Report raw duration, unpaid break duration, payable duration and overtime independently.

## Migration and backup requirements

Migrations have increasing IDs, run transactionally, record applied version and are safe to verify on a fresh DB. Before schema migration take a consistent backup; online backup uses SQLite's backup API or quiesced copy (not arbitrary copy of a live DB/WAL). Restore drills verify both DB integrity and application startup. Retention/deletion policy remains an organization decision.
