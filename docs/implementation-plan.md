# Implementation plan

**Current gate:** Owner reviewed the feature matrix and architecture on 2026-10-28 and approved continuing the build. Work since that review: organization-owned screen-snapshot policy (disabled by default), randomized server-issued capture schedule with retention pruning and scoped frame access, employee capture indicator plus admin settings UI, and a team frame browser. The application remains a tested milestone, not the full production P0 workforce platform.

## Milestone 0 — evidence and architecture (complete; owner review gate before broader build)

Created environment/skill audit, public-source research, evidence register, screen/workflow inventory, feature matrix, architecture, data model, API and security plans. The earlier research used official public pages/docs only. The installed skill instructs skipping REA for ordinary source-repository analysis; signed-in reference behavior remains explicitly unverified.

## Milestone 1 — runnable foundation (implemented; verified locally)

- Node 24 ESM app using built-in SQLite, explicit migration command, health checks and dev-only seed.
- CLI first-admin provisioning, scrypt passwords, hashed opaque sessions, login/logout, origin check and role-scoped API.
- Original responsive employee/manager/admin interface with attendance, timesheet, team, approvals, reports and audit areas.
- Ten `node:test` unit/HTTP integration tests passed at the review gate; three snapshot tests were added afterwards (13 total). Migration integrity check passes.

**Remaining:** no email invitation/recovery, manager/admin employee-management UI, browser visual/accessibility review, full security/rate-limit review, backups, packaged release or production deployment.

## Milestone 2 — attendance core (partially implemented; current review milestone)

Implemented persisted server-timestamped clock in/out, organization-owned paid/unpaid break policy (unpaid default, admin-editable, captured when a break starts), one open session/break constraints, transaction/idempotency, local-timezone date filtering, personal/team timesheets, correction request and manager approval adjustment, employee weekly timesheet create/submit UI with server refusal while a session overlaps the submitted period, approve/reject/reopen API states, scoped team list, CSV export and audit rows.

**Acceptance still required before calling P0 complete:** concurrent two-tab clock-in test; robust state/event consistency/reconciliation; session expiry and disabled-account tests; correction rejection, repeat decisions and adjustment-pay-period semantics; approved timesheet data locking against punch changes; clarify correction resubmission; authenticated cross-tenant HTTP test; malicious CSV formula tests; full workflow in a real browser; explicit office policies for overtime, schedules, holiday, leave and pay periods; rate limiting and request input/accessibility review. Current-week submit is implemented; generalized period selection and a locked payroll snapshot are not.

## Milestone 3 — P1 workforce management

Not implemented: teams/departments admin, invitation and deactivation UI, schedules/holidays, leave and balances, projects/activities, notification inbox, bulk operations and advanced reports. Implement only with office rules and acceptance tests.

## Milestone 4 — deployment and hardening

Local setup/migration/provisioning instructions are in `deployment.md`. Not complete: TLS/proxy-origin allowlist, automated backup/restore, CI, security/dependency scanning, response/error hardening, browser accessibility and deployment/rollback smoke tests. Do not deploy without explicit request.

## Milestone 5 — optional P2

Offline synchronization, kiosk/location verification and payroll integrations deferred; GPS and biometrics are not enabled by default.

## Open office decisions

Jurisdiction, organization timezone, workweek/pay-period boundaries, schedule/holiday ownership, desired break compensation default (currently unpaid and admin-configurable), overtime threshold/multiplier, rounding, grace/missing-punch policy, retention, production host, backup retention and invitation/recovery mail. Until supplied, the app is operational and configurable only in limited scope—not payroll/legal advice.

Exact executed checks and limitations are in [test-report.md](test-report.md). Feature status remains in [feature-matrix.md](feature-matrix.md). The owner review gate was cleared on 2026-10-28; future large scope changes should still be reviewed against [feature-matrix.md](feature-matrix.md) and [architecture.md](architecture.md).
