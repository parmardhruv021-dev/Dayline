import { createHash } from 'node:crypto';
import { db, transaction, id, now, audit } from './db.mjs';
import { localDateRange, sumSessionDurations } from './time.mjs';

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function ensureKey(key) {
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key between 8 and 128 characters.');
  return key;
}

function runIdempotent(actor, key, operation, payload, fn) {
  ensureKey(key);
  const fingerprint = createHash('sha256').update(JSON.stringify({ operation, payload })).digest('hex');
  return transaction(() => {
    const old = db.prepare(`SELECT operation, request_hash, response_json FROM idempotency_results
      WHERE organization_id=? AND actor_membership_id=? AND key=?`).get(actor.organization_id, actor.membership_id, key);
    if (old) {
      if (old.operation !== operation || old.request_hash !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request.');
      return JSON.parse(old.response_json);
    }
    const data = fn();
    db.prepare(`INSERT INTO idempotency_results
      (organization_id,actor_membership_id,key,operation,request_hash,response_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(actor.organization_id, actor.membership_id, key, operation, fingerprint, JSON.stringify(data), now());
    return data;
  });
}

function activeSession(actor) {
  return db.prepare(`SELECT * FROM work_sessions WHERE organization_id=? AND membership_id=? AND ended_at IS NULL`)
    .get(actor.organization_id, actor.membership_id);
}

function activeBreak(sessionId) {
  return db.prepare('SELECT * FROM breaks WHERE work_session_id=? AND ended_at IS NULL').get(sessionId);
}

function recordEvent(actor, session, kind, key, at) {
  db.prepare(`INSERT INTO attendance_events
    (id,organization_id,membership_id,work_session_id,actor_membership_id,kind,occurred_at,recorded_at,idempotency_key)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id(), actor.organization_id, actor.membership_id, session.id, actor.membership_id, kind, at, at, key);
}

export function clock(actor, action, key) {
  return runIdempotent(actor, key, `clock:${action}`, {}, () => {
    const at = now();
    if (action === 'in') {
      if (activeSession(actor)) throw new AppError(409, 'ALREADY_CLOCKED_IN', 'You already have an active work session.');
      const session = { id: id() };
      db.prepare(`INSERT INTO work_sessions(id,organization_id,membership_id,started_at,created_at) VALUES (?,?,?,?,?)`)
        .run(session.id, actor.organization_id, actor.membership_id, at, at);
      recordEvent(actor, session, 'clock_in', key, at);
      audit(actor.organization_id, actor.membership_id, 'attendance.clock_in', 'work_session', session.id);
      return { sessionId: session.id, state: 'working', startedAt: at, serverTime: at };
    }
    if (action === 'out') {
      const session = activeSession(actor);
      if (!session) throw new AppError(409, 'NOT_CLOCKED_IN', 'There is no active work session to clock out.');
      if (activeBreak(session.id)) throw new AppError(409, 'BREAK_STILL_OPEN', 'End your break before clocking out.');
      db.prepare('UPDATE work_sessions SET ended_at=? WHERE id=? AND ended_at IS NULL').run(at, session.id);
      recordEvent(actor, session, 'clock_out', key, at);
      audit(actor.organization_id, actor.membership_id, 'attendance.clock_out', 'work_session', session.id);
      return { sessionId: session.id, state: 'clocked_out', startedAt: session.started_at, endedAt: at, serverTime: at };
    }
    throw new AppError(400, 'INVALID_ACTION', 'Unknown clock action.');
  });
}

export function breakAction(actor, action, key) {
  if (action !== 'start' && action !== 'end') throw new AppError(400, 'INVALID_ACTION', 'Unknown break action.');
  return runIdempotent(actor, key, `break:${action}`, {}, () => {
    const session = activeSession(actor);
    if (!session) throw new AppError(409, 'NOT_CLOCKED_IN', 'Clock in before managing a break.');
    const at = now();
    if (action === 'start') {
      if (activeBreak(session.id)) throw new AppError(409, 'BREAK_ALREADY_OPEN', 'A break is already in progress.');
      const policy = db.prepare('SELECT breaks_paid FROM organizations WHERE id=?').get(actor.organization_id);
      const paid = !!policy?.breaks_paid;
      const breakId = id();
      db.prepare(`INSERT INTO breaks(id,organization_id,work_session_id,started_at,paid) VALUES (?,?,?,?,?)`)
        .run(breakId, actor.organization_id, session.id, at, paid ? 1 : 0);
      recordEvent(actor, session, 'break_start', key, at);
      audit(actor.organization_id, actor.membership_id, 'attendance.break_start', 'break', breakId, null, { paid });
      return { breakId, state: 'on_break', startedAt: at, paid, serverTime: at };
    }
    const open = activeBreak(session.id);
    if (!open) throw new AppError(409, 'NO_OPEN_BREAK', 'There is no open break to end.');
    db.prepare('UPDATE breaks SET ended_at=? WHERE id=? AND ended_at IS NULL').run(at, open.id);
    recordEvent(actor, session, 'break_end', key, at);
    audit(actor.organization_id, actor.membership_id, 'attendance.break_end', 'break', open.id);
    return { breakId: open.id, state: 'working', startedAt: open.started_at, endedAt: at, paid: !!open.paid, serverTime: at };
  });
}

function sessionSummary(row, adjustments = 0, at = Date.now()) {
  const start = Date.parse(row.started_at);
  const end = row.ended_at ? Date.parse(row.ended_at) : at;
  const elapsed = Math.max(0, end - start);
  const unpaid = (row.breaks || []).reduce((sum, item) => {
    const bStart = Date.parse(item.started_at);
    const bEnd = item.ended_at ? Date.parse(item.ended_at) : at;
    return sum + (item.paid ? 0 : Math.max(0, bEnd - bStart));
  }, 0);
  return { ...row, breaks: row.breaks || [], rawMs: elapsed, unpaidBreakMs: unpaid, payableMs: Math.max(0, elapsed - unpaid + adjustments) };
}

export function sessionRows(orgId, membershipId, fromDate, toDate, timeZone) {
  const range = localDateRange(fromDate, toDate, timeZone);
  const rows = db.prepare(`SELECT * FROM work_sessions WHERE organization_id=? AND membership_id=?
    AND started_at < ? AND COALESCE(ended_at, ?) > ? ORDER BY started_at LIMIT 5000`).all(orgId, membershipId, range.end, range.end, range.start);
  const sessionIds = rows.map((row) => row.id);
  if (!sessionIds.length) return [];
  const placeholders = sessionIds.map(() => '?').join(',');
  const breaks = db.prepare(`SELECT work_session_id,started_at,ended_at,paid FROM breaks WHERE organization_id=? AND work_session_id IN (${placeholders})`).all(orgId, ...sessionIds);
  const adjustments = db.prepare(`SELECT work_session_id, SUM(delta_ms) AS delta FROM time_adjustments WHERE organization_id=? AND work_session_id IN (${placeholders}) GROUP BY work_session_id`).all(orgId, ...sessionIds);
  const bySession = new Map();
  for (const item of breaks) { if (!bySession.has(item.work_session_id)) bySession.set(item.work_session_id, []); bySession.get(item.work_session_id).push({ ...item, paid: !!item.paid }); }
  const adjustmentMap = new Map(adjustments.map((item) => [item.work_session_id, item.delta || 0]));
  return rows.map((row) => {
    const withBreaks = { ...row, breaks: bySession.get(row.id) || [] };
    const duration = sumSessionDurations(withBreaks, range.start, range.end);
    const adjustmentAt = row.ended_at ? Date.parse(row.ended_at) : Date.now();
    const adjustment = adjustmentAt >= Date.parse(range.start) && adjustmentAt < Date.parse(range.end) ? (adjustmentMap.get(row.id) || 0) : 0;
    return { ...withBreaks, ...duration, payableMs: Math.max(0, duration.payableMs + adjustment) };
  });
}

export function currentState(actor) {
  const at = Date.now();
  const session = activeSession(actor);
  const org = db.prepare('SELECT time_zone FROM organizations WHERE id=?').get(actor.organization_id);
  const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: org.time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  const todayRows = sessionRows(actor.organization_id, actor.membership_id, todayDate, todayDate, org.time_zone);
  const today = todayRows.reduce((sum, item) => ({ rawMs: sum.rawMs + item.rawMs, unpaidBreakMs: sum.unpaidBreakMs + item.unpaidBreakMs, payableMs: sum.payableMs + item.payableMs }), { rawMs: 0, unpaidBreakMs: 0, payableMs: 0 });
  if (!session) return { state: 'clocked_out', session: null, today, serverTime: new Date(at).toISOString(), dayStartUtc: localDateRange(todayDate,todayDate,org.time_zone).start };
  const row = db.prepare('SELECT * FROM work_sessions WHERE id=?').get(session.id);
  const breaks = db.prepare('SELECT * FROM breaks WHERE work_session_id=? ORDER BY started_at').all(session.id).map((b) => ({ ...b, paid: !!b.paid }));
  const adjustments = db.prepare('SELECT COALESCE(SUM(delta_ms),0) AS delta FROM time_adjustments WHERE organization_id=? AND work_session_id=?').get(actor.organization_id, session.id).delta;
  const summary = sessionSummary({ ...row, breaks }, adjustments, at);
  const open = activeBreak(session.id);
  return { state: open ? 'on_break' : 'working', session: { ...summary, openBreak: open || null }, today, serverTime: new Date(at).toISOString(), dayStartUtc: localDateRange(todayDate,todayDate,org.time_zone).start };
}
