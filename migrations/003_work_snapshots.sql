ALTER TABLE organizations
ADD COLUMN snapshots_enabled INTEGER NOT NULL DEFAULT 0 CHECK (snapshots_enabled IN (0,1));

ALTER TABLE organizations
ADD COLUMN snapshot_min_interval_s INTEGER NOT NULL DEFAULT 180 CHECK (snapshot_min_interval_s BETWEEN 30 AND 7200);

ALTER TABLE organizations
ADD COLUMN snapshot_max_interval_s INTEGER NOT NULL DEFAULT 480 CHECK (snapshot_max_interval_s BETWEEN 30 AND 7200);

ALTER TABLE organizations
ADD COLUMN snapshot_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (snapshot_retention_days BETWEEN 1 AND 365);

CREATE TABLE work_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  work_session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'captured' CHECK (status IN ('captured','capture_unavailable')),
  captured_at TEXT NOT NULL,
  next_due_at TEXT NOT NULL,
  image BLOB,
  content_type TEXT,
  width INTEGER,
  height INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, work_session_id) REFERENCES work_sessions(organization_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'captured' AND image IS NOT NULL) OR (status = 'capture_unavailable' AND image IS NULL)),
  CHECK (next_due_at > captured_at)
);

CREATE INDEX work_snapshots_session ON work_snapshots(organization_id, work_session_id, captured_at);
CREATE INDEX work_snapshots_member_time ON work_snapshots(organization_id, membership_id, captured_at);
