PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  week_starts_on INTEGER NOT NULL DEFAULT 1 CHECK (week_starts_on BETWEEN 0 AND 6),
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee','manager','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  manager_membership_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, manager_membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX memberships_org_role_status ON memberships(organization_id, role, status);
CREATE INDEX memberships_manager ON memberships(organization_id, manager_membership_id);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_user_expiry ON auth_sessions(user_id, expires_at);

CREATE TABLE work_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE UNIQUE INDEX one_active_session_per_member ON work_sessions(organization_id, membership_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX work_sessions_org_id ON work_sessions(organization_id, id);
CREATE INDEX work_sessions_member_time ON work_sessions(organization_id, membership_id, started_at);

CREATE TABLE attendance_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  work_session_id TEXT NOT NULL,
  actor_membership_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('clock_in','clock_out','break_start','break_end')),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, work_session_id) REFERENCES work_sessions(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (organization_id, actor_membership_id, idempotency_key)
);
CREATE INDEX attendance_events_member_time ON attendance_events(organization_id, membership_id, occurred_at);

CREATE TABLE breaks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  work_session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  paid INTEGER NOT NULL CHECK (paid IN (0,1)),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (work_session_id) REFERENCES work_sessions(id) ON DELETE RESTRICT,
  CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE UNIQUE INDEX one_open_break_per_session ON breaks(work_session_id) WHERE ended_at IS NULL;

CREATE TABLE time_adjustments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  work_session_id TEXT NOT NULL,
  correction_request_id TEXT,
  delta_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, work_session_id) REFERENCES work_sessions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX adjustments_session ON time_adjustments(organization_id, work_session_id);

CREATE TABLE correction_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  work_session_id TEXT,
  requester_membership_id TEXT NOT NULL,
  delta_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','clarification_requested')),
  resolver_membership_id TEXT,
  resolution_reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, requester_membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, resolver_membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, work_session_id) REFERENCES work_sessions(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX correction_queue ON correction_requests(organization_id, status, created_at);

CREATE TABLE timesheets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_at TEXT,
  approved_at TEXT,
  approved_by_membership_id TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, membership_id, period_start, period_end),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, approved_by_membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  CHECK (period_end > period_start)
);
CREATE INDEX timesheets_queue ON timesheets(organization_id, status, period_end);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_membership_id TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  reason TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX audit_scope_time ON audit_events(organization_id, actor_membership_id, occurred_at);

CREATE TABLE idempotency_results (
  organization_id TEXT NOT NULL,
  actor_membership_id TEXT NOT NULL,
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_membership_id, key),
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT
);
