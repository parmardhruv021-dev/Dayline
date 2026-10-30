import { createHash, randomInt } from 'node:crypto';
import { db, id, now, transaction, audit } from './db.mjs';
import { AppError } from './attendance.mjs';

const MAX_IMAGE_BYTES = 384 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function snapshotPolicy(orgId) {
  const row = db.prepare(`SELECT snapshots_enabled, snapshot_min_interval_s, snapshot_max_interval_s, snapshot_retention_days
    FROM organizations WHERE id=?`).get(orgId);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'The requested record was not found.');
  const min = row.snapshot_min_interval_s;
  const max = Math.max(min, row.snapshot_max_interval_s);
  return { enabled: !!row.snapshots_enabled, minIntervalSeconds: min, maxIntervalSeconds: max, retentionDays: row.snapshot_retention_days };
}

function activeSessionOf(actor) {
  return db.prepare(`SELECT * FROM work_sessions WHERE organization_id=? AND membership_id=? AND ended_at IS NULL`)
    .get(actor.organization_id, actor.membership_id);
}

function openBreakOf(sessionId) {
  return db.prepare('SELECT id FROM breaks WHERE work_session_id=? AND ended_at IS NULL').get(sessionId);
}

// First due time is derived deterministically from the session id so the server
// chooses the initial randomized delay without an extra write.
function firstDueOffsetMs(sessionId, policy) {
  const span = policy.maxIntervalSeconds - policy.minIntervalSeconds + 1;
  const digest = createHash('sha256').update(sessionId).digest();
  const pick = digest.readUInt32BE(0) % span;
  return (policy.minIntervalSeconds + pick) * 1000;
}

export function captureConfig(actor) {
  const policy = snapshotPolicy(actor.organization_id);
  const session = activeSessionOf(actor);
  if (!policy.enabled || !session) return { ...policy, sessionOpen: !!session, capturing: false, firstDueAt: null, lastCaptureAt: null };
  const last = db.prepare(`SELECT captured_at FROM work_snapshots WHERE organization_id=? AND work_session_id=? ORDER BY captured_at DESC LIMIT 1`)
    .get(actor.organization_id, session.id);
  const firstDueAt = new Date(Date.parse(session.started_at) + firstDueOffsetMs(session.id, policy)).toISOString();
  return { ...policy, sessionOpen: true, capturing: !openBreakOf(session.id), firstDueAt, lastCaptureAt: last?.captured_at || null };
}

function decodeImage(input) {
  if (typeof input.image !== 'string' || !input.image) throw new AppError(400, 'SNAPSHOT_IMAGE_REQUIRED', 'A captured frame is required.');
  const comma = input.image.indexOf(',');
  const base64 = comma >= 0 ? input.image.slice(comma + 1) : input.image;
  let buffer;
  try { buffer = Buffer.from(base64, 'base64'); } catch { throw new AppError(400, 'SNAPSHOT_IMAGE_INVALID', 'The captured frame could not be decoded.'); }
  if (!buffer.length) throw new AppError(400, 'SNAPSHOT_IMAGE_INVALID', 'The captured frame could not be decoded.');
  if (buffer.length > MAX_IMAGE_BYTES) throw new AppError(413, 'SNAPSHOT_TOO_LARGE', 'The captured frame exceeds the 384 KB limit.');
  const contentType = String(input.contentType || 'image/jpeg').toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) throw new AppError(400, 'SNAPSHOT_TYPE_INVALID', 'Only JPEG, PNG or WebP frames are accepted.');
  const width = Number.isInteger(input.width) && input.width > 0 && input.width <= 7680 ? input.width : null;
  const height = Number.isInteger(input.height) && input.height > 0 && input.height <= 4320 ? input.height : null;
  return { buffer, contentType, width, height };
}

function pruneExpired(orgId, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  db.prepare('DELETE FROM work_snapshots WHERE organization_id=? AND captured_at < ?').run(orgId, cutoff);
}

export function recordCapture(actor, input) {
  const policy = snapshotPolicy(actor.organization_id);
  if (!policy.enabled) throw new AppError(409, 'SNAPSHOT_DISABLED', 'Screen snapshots are not enabled for this organization.');
  const session = activeSessionOf(actor);
  if (!session) throw new AppError(409, 'NOT_CLOCKED_IN', 'Clock in before recording a snapshot.');
  if (openBreakOf(session.id)) throw new AppError(409, 'ON_BREAK', 'Snapshots pause while you are on a break.');
  const unavailable = input?.status === 'capture_unavailable';
  const media = unavailable ? null : decodeImage(input);
  return transaction(() => {
    const at = Date.now();
    const snapshotId = id();
    if (unavailable) {
      const already = db.prepare(`SELECT id FROM work_snapshots WHERE organization_id=? AND work_session_id=? AND status='capture_unavailable' LIMIT 1`)
        .get(actor.organization_id, session.id);
      if (already) return { id: already.id, status: 'capture_unavailable', capturedAt: null, nextDueAt: null, retryAfterMs: 0, alreadyRecorded: true };
      const capturedAt = new Date(at).toISOString();
      db.prepare(`INSERT INTO work_snapshots(id,organization_id,membership_id,work_session_id,status,captured_at,next_due_at,bytes)
        VALUES (?,?,?,?,'capture_unavailable',?, ?,0)`).run(snapshotId, actor.organization_id, actor.membership_id, session.id, capturedAt, new Date(at + 1000).toISOString());
      audit(actor.organization_id, actor.membership_id, 'snapshot.capture_unavailable', 'work_session', session.id, 'Screen-share permission declined by the employee.');
      pruneExpired(actor.organization_id, policy.retentionDays);
      return { id: snapshotId, status: 'capture_unavailable', capturedAt, nextDueAt: null, retryAfterMs: 0 };
    }
    const last = db.prepare(`SELECT captured_at, next_due_at FROM work_snapshots
      WHERE organization_id=? AND work_session_id=? AND status='captured' ORDER BY captured_at DESC LIMIT 1`).get(actor.organization_id, session.id);
    if (last && at < Date.parse(last.next_due_at)) {
      const error = new AppError(429, 'SNAPSHOT_TOO_SOON', 'The next snapshot is not due yet.');
      error.retryAfterMs = Date.parse(last.next_due_at) - at;
      throw error;
    }
    const span = policy.maxIntervalSeconds - policy.minIntervalSeconds + 1;
    const nextDueAt = new Date(at + (policy.minIntervalSeconds + randomInt(0, span)) * 1000).toISOString();
    db.prepare(`INSERT INTO work_snapshots(id,organization_id,membership_id,work_session_id,status,captured_at,next_due_at,image,content_type,width,height,bytes)
      VALUES (?,?,?,?,'captured',?,?,?,?,?,?,?)`)
      .run(snapshotId, actor.organization_id, actor.membership_id, session.id, new Date(at).toISOString(), nextDueAt,
        media.buffer, media.contentType, media.width, media.height, media.buffer.length);
    pruneExpired(actor.organization_id, policy.retentionDays);
    return { id: snapshotId, status: 'captured', capturedAt: new Date(at).toISOString(), nextDueAt, retryAfterMs: 0, bytes: media.buffer.length };
  });
}

export function listSnapshots(orgId, membershipId, sessionId = null) {
  const rows = sessionId
    ? db.prepare(`SELECT id,membership_id,work_session_id,status,captured_at,next_due_at,content_type,width,height,bytes
        FROM work_snapshots WHERE organization_id=? AND membership_id=? AND work_session_id=? ORDER BY captured_at`).all(orgId, membershipId, sessionId)
    : db.prepare(`SELECT id,membership_id,work_session_id,status,captured_at,next_due_at,content_type,width,height,bytes
        FROM work_snapshots WHERE organization_id=? AND membership_id=? ORDER BY captured_at DESC LIMIT 200`).all(orgId, membershipId);
  return rows.map((row) => ({ ...row, hasImage: row.status === 'captured' }));
}

export function snapshotForRead(actor, snapshotId, canManageFn) {
  const row = db.prepare('SELECT * FROM work_snapshots WHERE organization_id=? AND id=?').get(actor.organization_id, snapshotId);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'The requested snapshot was not found.');
  const target = db.prepare('SELECT * FROM memberships WHERE organization_id=? AND id=?').get(actor.organization_id, row.membership_id);
  if (row.membership_id !== actor.membership_id && !canManageFn(target)) throw new AppError(404, 'NOT_FOUND', 'The requested snapshot was not found.');
  return row;
}