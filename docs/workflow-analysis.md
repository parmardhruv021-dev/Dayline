# Workflow analysis

**Status:** Requirements synthesis from official public Jibble docs and user requirements. It is not an observed end-to-end Jibble walkthrough. Every reference statement is evidence-qualified in [evidence-register.md](evidence-register.md). Independent Dayline choices are marked **Design**; policy/legal choices that require the office remain open.

## Authentication, tenant setup, membership

- **Reference evidence:** roles, invitations, groups, and configured scopes are documented (E-13, E-14). Password creation, recovery, expiry, onboarding validation, and refresh behavior were not observed.
- **Independent flow:** admin creates organization with explicit IANA timezone and week/pay-period configuration; administrator invites employee by an expiring single-use token; invite acceptance binds the authenticated user to an organization membership; role assignment is server-side. Deactivation preserves historical attendance. Do not claim email invitations work until delivery provider is configured.
- **Open:** recovery/invitation delivery dependency, organization verification, initial admin bootstrap procedure, employee identity lifecycle.

## Clock in/out and event integrity

- **Reference evidence:** multiple clock methods and role-limited team tracking are documented (E-02, E-03). Exact duplicate, race, offline conflict, and missing-punch recovery rules are unknown. Offline clocking has documented scope/limitations (E-12) and is out of P0.
- **Independent flow:** authenticated employee calls server command; server derives actor/org/time, checks active session and policy, inserts an immutable event and updates derived session in one transaction. Unique active session constraint plus immediate transaction prevents double clock-in. An idempotency key makes retries return the original result. Clock-out closes exactly the current employee session. UI timer derives from persisted start time plus server anchor.
- **Open:** whether concurrent devices should let an admin close a session, handling misordered event requests, retention, and office schedule grace rules.

## Break lifecycle and payable time

- **Reference evidence:** clocked-in prerequisite, separate start/end, and schedule-defined custom-break constraints are documented (E-04, E-05).
- **Independent flow:** one open break per session; paid/unpaid is fixed from the policy effective at event time; end break closes interval transactionally. An unfinished break is an exception, never silently discarded. Raw duration is exact seconds/milliseconds; unpaid intervals deducted only by configured policy. No local legal rule assumed.
- **Open:** paid-break defaults and schedule enforcement. P0 may ship configurable unpaid break semantics only after explicit test coverage.

## Corrections, audit, and approval

- **Reference evidence:** authorized manual entries and time-entry Change History are documented (E-06, E-07); timesheet approval lock and separate project approval behavior are documented (E-09, E-10).
- **Independent flow:** employee submits a correction request with target/date, proposed change, reason; manager with assigned scope can approve/reject/request clarification. Approval creates an append-only adjustment referencing the original event; raw event is preserved. Every decision is audited with actor, reason, timestamp, and before/after summary. Timesheet review transitions draft/submitted to approved or rejected; approved period becomes immutable except explicit reopen with reason and audit.
- **Open:** pay-period boundaries, resubmission, manager self-approval, and correction interaction with already approved periods. Default: prohibit self-approval; require reopen before approved-period adjustment.

## Timesheets, schedule, time zone, overtime

- **Reference evidence:** daily/weekly/monthly views, payroll/pay period approvals, and member timezone behavior are documented (E-08, E-09, E-11). Exact rounding/overtime/DST logic not established.
- **Independent flow:** store absolute event instants in UTC and organization/member IANA time zone separately; calculate business date with policy timezone and interval boundaries. Split cross-midnight shifts by local calendar boundary before aggregating; use time-zone database conversion to handle DST gaps/repeats. Show raw, payable, scheduled and overtime hours distinctly. Configuration controls workweek start, pay-period start/type, rounding mode (off by default), break rules, overtime threshold/multiplier; changes are effective-dated and audited.
- **Open:** office jurisdiction and payroll policy. Totals are operational estimates, not payroll/legal advice until reviewed and locked to a documented policy.

## Team oversight and exceptions

- **Reference evidence:** roles/groups and attendance reporting exist (E-13, E-14, E-17), but signed-in live dashboard behavior was not inspected.
- **Independent flow:** manager list is scoped to explicit assigned teams, not a client filter alone. Current state is derived from persisted session/break events as of server query time. Missing/late states require an assigned schedule, holiday calendar, and grace policy; absent these, show “not clocked in” without asserting absent/late. Exception inbox records reason, source, status, resolver, and resolution history.
- **Open:** refresh channel choice and schedule/holiday policy adoption.

## Leave and schedules

- **Reference evidence:** schedule types, holiday calendars, paid/unpaid policies, accrual and approval levels are documented (E-15).
- **Independent flow:** initial milestone should model policy and requests but defer balance accrual/entitlement until office rules are supplied. A request must not become approved or decrement balance until approver transition commits. Overlapping requests/shifts must be checked transactionally.
- **Open:** legal requirements, accrual/carry-over, approval chain, timezone and holiday ownership. No entitlement is fabricated.

## Project/activity reporting and export

- **Reference evidence:** activities and projects/clients are distinct; reports are role-scoped and export formats vary by report (E-16, E-17).
- **Independent flow:** a session may reference allowed project/activity IDs; report query enforces actor's organization/team scope server-side. Date filtering uses an explicit timezone and half-open interval. CSV fields are escaped correctly, UTF-8/BOM policy documented, formula-leading values neutralized for spreadsheet safety. Export is generated from query data, not demo rows.
- **Open:** billable rates/invoicing and optional project approvals; defer until P0.

## Notifications and offline behavior

- Reference notification timing and delivery semantics are not established. Offline support is documented for a subset of Jibble apps (E-12), but it adds conflict risk.
- P0 notifications are persisted in-app records emitted by actual operations. No email/push adapter is claimed without configuration. Offline queue is deferred; if later implemented, events need a client-generated idempotency token, original capture time plus trust classification, server receipt time, explicit conflict resolution, and audit.
