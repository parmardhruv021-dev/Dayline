import './env.mjs';
import { createServer } from 'node:http';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { db, id, now, transaction, audit, hashText } from './db.mjs';
import { AppError, breakAction, clock, currentState, sessionRows } from './attendance.mjs';
import { snapshotPolicy, captureConfig, recordCapture, listSnapshots, snapshotForRead } from './snapshots.mjs';
import { localDateRange } from './time.mjs';

const scrypt = promisify(scryptCallback);
const root = resolve(new URL('..', import.meta.url).pathname);
const publicDir = resolve(root, 'public');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const cookieName = 'dayline_session';
const sessionSecret = process.env.SESSION_SECRET || '';

function requireConfig() {
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters.');
  if (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'true') throw new Error('Set COOKIE_SECURE=true in production.');
}
function cookieOptions() { return `Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`; }
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map((v) => v.trim()).filter(Boolean).map((v) => { const i = v.indexOf('='); return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))]; })); }
function json(res, status, data, requestId, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId, ...headers }); res.end(JSON.stringify({ data, requestId })); }
function fail(res, error, requestId) { const status = error instanceof AppError ? error.status : Number.isInteger(error.status) ? error.status : 500; if (status >= 500) console.error(`[${requestId}]`, error); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId }); res.end(JSON.stringify({ error: { code: error.code || 'INTERNAL_ERROR', message: status >= 500 ? 'An internal error occurred.' : error.message }, requestId })); }
async function body(req, limit = 65536) { let text = ''; for await (const part of req) { text += part; if (text.length > limit) throw new AppError(413, 'BODY_TOO_LARGE', 'Request body is too large.'); } if (!text) return {}; try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw new AppError(400, 'INVALID_JSON', 'Request body must be a JSON object.'); } }
function actorFor(userId, orgId = null) {
  const rows = db.prepare(`SELECT m.id AS membership_id,m.organization_id,m.user_id,m.role,m.status,u.full_name,u.email,o.name AS organization_name,o.time_zone
    FROM memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.organization_id
    WHERE m.user_id=? AND m.status='active' AND u.status='active' ORDER BY m.created_at`).all(userId);
  return rows.find((row) => row.organization_id === orgId) || rows[0] || null;
}
function sessionActor(req) {
  const token = cookies(req)[cookieName]; if (!token) return null;
  const row = db.prepare(`SELECT u.id AS user_id FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active'`).get(hashText(token), now());
  return row ? actorFor(row.user_id, req.headers['x-organization-id'] || null) : null;
}
function requireActor(req) { const actor = sessionActor(req); if (!actor) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'); return actor; }
function requireRole(actor, roles) { if (!roles.includes(actor.role)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'); }
function requireSameOrigin(req) { const origin = req.headers.origin; if (!origin) return; const expected = `http://${req.headers.host}`; const secureExpected = `https://${req.headers.host}`; if (origin !== expected && origin !== secureExpected) throw new AppError(403, 'CROSS_ORIGIN', 'Cross-origin requests are not allowed.'); }
function key(req) { return req.headers['idempotency-key']; }
function parseDate(value, field) { if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) throw new AppError(400, 'INVALID_DATE', `${field} must be a valid date in YYYY-MM-DD format.`); return value; }
function canManage(actor, targetMembership) { return actor.role === 'admin' || (actor.role === 'manager' && targetMembership?.manager_membership_id === actor.membership_id); }
function targetMembership(actor, idValue) { const target = db.prepare('SELECT * FROM memberships WHERE organization_id=? AND id=? AND status=\'active\'').get(actor.organization_id, idValue); if (!target) throw new AppError(404, 'NOT_FOUND', 'The requested record was not found.'); if (target.id !== actor.membership_id && !canManage(actor, target)) throw new AppError(404, 'NOT_FOUND', 'The requested record was not found.'); return target; }
function totals(rows) { return rows.reduce((sum, row) => ({ rawMs: sum.rawMs + row.rawMs, unpaidBreakMs: sum.unpaidBreakMs + row.unpaidBreakMs, payableMs: sum.payableMs + row.payableMs }), { rawMs: 0, unpaidBreakMs: 0, payableMs: 0 }); }
function sessionInScope(actor, sessionId) { const row = db.prepare('SELECT ws.*,m.manager_membership_id FROM work_sessions ws JOIN memberships m ON m.id=ws.membership_id WHERE ws.organization_id=? AND ws.id=?').get(actor.organization_id, sessionId); if (!row) throw new AppError(404, 'NOT_FOUND', 'The requested session was not found.'); if (row.membership_id !== actor.membership_id && !canManage(actor, row)) throw new AppError(404, 'NOT_FOUND', 'The requested session was not found.'); return row; }
function currentPolicies(actor) {
  const org = db.prepare('SELECT breaks_paid FROM organizations WHERE id=?').get(actor.organization_id);
  const snapshot = snapshotPolicy(actor.organization_id);
  return { breaksPaid: !!org?.breaks_paid, snapshotsEnabled: snapshot.enabled, snapshotMinIntervalSeconds: snapshot.minIntervalSeconds, snapshotMaxIntervalSeconds: snapshot.maxIntervalSeconds, snapshotRetentionDays: snapshot.retentionDays };
}
function activeWorkOverlappingPeriod(actor, sheet) {
  const range = localDateRange(sheet.period_start, sheet.period_end, actor.time_zone);
  return db.prepare(`SELECT id FROM work_sessions WHERE organization_id=? AND membership_id=? AND ended_at IS NULL
    AND started_at < ? AND COALESCE(ended_at, ?) > ? LIMIT 1`)
    .get(actor.organization_id, actor.membership_id, range.end, range.end, range.start);
}

async function route(req, res, requestId) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const path = url.pathname; const method = req.method;
  if (method === 'GET' && path === '/health/live') return json(res, 200, { status: 'ok' }, requestId);
  if (method === 'GET' && path === '/health/ready') { db.prepare('SELECT 1').get(); return json(res, 200, { status: 'ready' }, requestId); }
  if (method === 'GET' && path === '/api/v1/auth/me') { const actor = requireActor(req); return json(res, 200, { user: { id: actor.user_id, name: actor.full_name, email: actor.email }, membership: { id: actor.membership_id, organizationId: actor.organization_id, organization: actor.organization_name, role: actor.role, timeZone: actor.time_zone } }, requestId); }
  if (method === 'POST' && path === '/api/v1/auth/login') {
    requireSameOrigin(req);
    const input = await body(req); if (typeof input.email !== 'string' || typeof input.password !== 'string') throw new AppError(400, 'INVALID_INPUT', 'Email and password are required.');
    const user = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE AND status=\'active\'').get(input.email.trim());
    let valid = false; if (user) { const [salt, stored] = user.password_hash.split(':'); const derived = await scrypt(input.password, salt, 64); valid = timingSafeEqual(Buffer.from(stored, 'hex'), derived); }
    if (!valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const token = randomBytes(32).toString('base64url'); const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(hashText(token), user.id, expires, now());
    const actor = actorFor(user.id); audit(actor.organization_id, actor.membership_id, 'auth.login', 'user', user.id);
    return json(res, 200, { user: { id: user.id, name: user.full_name, email: user.email }, membership: { organization: actor.organization_name, role: actor.role } }, requestId, { 'Set-Cookie': `${cookieName}=${encodeURIComponent(token)}; ${cookieOptions()}` });
  }
  if (method === 'POST' && path === '/api/v1/auth/logout') {
    requireSameOrigin(req); const token = cookies(req)[cookieName]; if (token) db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(now(), hashText(token));
    return json(res, 200, { signedOut: true }, requestId, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}` });
  }
  if (method === 'POST' && path === '/api/v1/auth/demo-login') {
    requireSameOrigin(req);
    if (process.env.ALLOW_DEMO_LOGIN !== 'true' || process.env.NODE_ENV === 'production') throw new AppError(404, 'NOT_FOUND', 'The requested route was not found.');
    const input = await body(req); const user = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(input.email || 'admin@dayline.test'); if (!user) throw new AppError(404, 'DEMO_NOT_SEEDED', 'Run the development seed command first.');
    const token = randomBytes(32).toString('base64url'); const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(hashText(token), user.id, expires, now());
    return json(res, 200, { demo: true, user: { name: user.full_name, email: user.email } }, requestId, { 'Set-Cookie': `${cookieName}=${encodeURIComponent(token)}; ${cookieOptions()}` });
  }

  if (!path.startsWith('/api/')) return serveStatic(path, res, requestId);
  if (path.startsWith('/api/v1/')) requireSameOrigin(req);
  const actor = requireActor(req);

  if (method === 'GET' && path === '/api/v1/attendance/current') return json(res, 200, currentState(actor), requestId);
  if (method === 'POST' && path === '/api/v1/attendance/clock-in') return json(res, 200, clock(actor, 'in', key(req)), requestId);
  if (method === 'POST' && path === '/api/v1/attendance/clock-out') return json(res, 200, clock(actor, 'out', key(req)), requestId);
  if (method === 'POST' && path === '/api/v1/attendance/breaks/start') { await body(req); return json(res, 200, breakAction(actor, 'start', key(req)), requestId); }
  if (method === 'POST' && path === '/api/v1/attendance/breaks/end') return json(res, 200, breakAction(actor, 'end', key(req)), requestId);

  if (method === 'GET' && path === '/api/v1/snapshots/config') return json(res, 200, captureConfig(actor), requestId);
  if (method === 'POST' && path === '/api/v1/attendance/snapshots') { const input = await body(req, 560 * 1024); return json(res, 201, recordCapture(actor, input), requestId); }
  if (method === 'GET' && path === '/api/v1/attendance/snapshots') {
    const sessionId = url.searchParams.get('sessionId');
    const requested = url.searchParams.get('membershipId');
    let targetMemberId = actor.membership_id;
    if (requested && requested !== actor.membership_id) {
      requireRole(actor, ['manager', 'admin']);
      const target = db.prepare('SELECT * FROM memberships WHERE organization_id=? AND id=?').get(actor.organization_id, requested);
      if (!target || !canManage(actor, target)) throw new AppError(404, 'NOT_FOUND', 'The requested record was not found.');
      targetMemberId = target.id;
    }
    return json(res, 200, { snapshots: listSnapshots(actor.organization_id, targetMemberId, sessionId) }, requestId);
  }
  const snapshotImage = path.match(/^\/api\/v1\/snapshots\/([0-9a-f-]+)\/image$/);
  if (method === 'GET' && snapshotImage) {
    const row = snapshotForRead(actor, snapshotImage[1], (target) => canManage(actor, target));
    if (row.status !== 'captured' || !row.image) throw new AppError(404, 'NOT_FOUND', 'The requested snapshot was not found.');
    res.writeHead(200, { 'Content-Type': row.content_type || 'image/jpeg', 'Content-Length': row.bytes, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-Request-Id': requestId });
    return res.end(Buffer.from(row.image));
  }

  if (method === 'GET' && path === '/api/v1/timesheets/me') {
    const from = parseDate(url.searchParams.get('from'), 'from'); const to = parseDate(url.searchParams.get('to'), 'to'); if (to < from) throw new AppError(400, 'INVALID_RANGE', 'to must not be before from.');
    const rows = sessionRows(actor.organization_id, actor.membership_id, from, to, actor.time_zone);
    return json(res, 200, { from, to, timeZone: actor.time_zone, sessions: rows, totals: totals(rows) }, requestId);
  }
  if (method === 'GET' && path === '/api/v1/corrections/mine') {
    const rows = db.prepare(`SELECT c.*, resolver.full_name AS resolver_name FROM correction_requests c
      LEFT JOIN memberships resolver_member ON resolver_member.id=c.resolver_membership_id
      LEFT JOIN users resolver ON resolver.id=resolver_member.user_id
      WHERE c.organization_id=? AND c.membership_id=? ORDER BY c.created_at DESC`).all(actor.organization_id, actor.membership_id);
    return json(res, 200, { corrections: rows }, requestId);
  }
  if (method === 'GET' && path === '/api/v1/timesheets') {
    const rows = db.prepare(`SELECT * FROM timesheets WHERE organization_id=? AND membership_id=? ORDER BY period_start DESC`).all(actor.organization_id, actor.membership_id);
    return json(res, 200, { timesheets: rows }, requestId);
  }
  if (method === 'GET' && path === '/api/v1/organization/policies') return json(res, 200, currentPolicies(actor), requestId);
  if (method === 'PATCH' && path === '/api/v1/organization/policies') {
    requireRole(actor, ['admin']);
    const input = await body(req);
    const sets = []; const params = []; const details = {};
    if ('breaksPaid' in input) {
      if (typeof input.breaksPaid !== 'boolean') throw new AppError(400, 'INVALID_POLICY', 'breaksPaid must be a boolean.');
      sets.push('breaks_paid=?'); params.push(input.breaksPaid ? 1 : 0); details.breaksPaid = input.breaksPaid;
    }
    if ('snapshotsEnabled' in input) {
      if (typeof input.snapshotsEnabled !== 'boolean') throw new AppError(400, 'INVALID_POLICY', 'snapshotsEnabled must be a boolean.');
      sets.push('snapshots_enabled=?'); params.push(input.snapshotsEnabled ? 1 : 0); details.snapshotsEnabled = input.snapshotsEnabled;
    }
    const intField = (name, column, min, max) => {
      if (!(name in input)) return;
      if (!Number.isInteger(input[name]) || input[name] < min || input[name] > max) throw new AppError(400, 'INVALID_POLICY', `${name} must be a whole number between ${min} and ${max}.`);
      sets.push(`${column}=?`); params.push(input[name]); details[name] = input[name];
    };
    intField('snapshotMinIntervalSeconds', 'snapshot_min_interval_s', 30, 7200);
    intField('snapshotMaxIntervalSeconds', 'snapshot_max_interval_s', 30, 7200);
    intField('snapshotRetentionDays', 'snapshot_retention_days', 1, 365);
    if (!sets.length) throw new AppError(400, 'INVALID_POLICY', 'Provide at least one setting to update.');
    if ('snapshotMinIntervalSeconds' in input || 'snapshotMaxIntervalSeconds' in input) {
      const current = snapshotPolicy(actor.organization_id);
      const min = input.snapshotMinIntervalSeconds ?? current.minIntervalSeconds;
      const max = input.snapshotMaxIntervalSeconds ?? current.maxIntervalSeconds;
      if (max < min) throw new AppError(400, 'INVALID_POLICY', 'The maximum snapshot interval must not be shorter than the minimum.');
    }
    transaction(() => {
      db.prepare(`UPDATE organizations SET ${sets.join(',')} WHERE id=?`).run(...params, actor.organization_id);
      const onlyBreaks = Object.keys(details).every((key) => key === 'breaksPaid');
      audit(actor.organization_id, actor.membership_id, onlyBreaks ? 'organization.break_policy_updated' : 'organization.policy_updated', 'organization', actor.organization_id, null, details);
    });
    return json(res, 200, currentPolicies(actor), requestId);
  }
  if (method === 'POST' && path === '/api/v1/timesheets') {
    const input = await body(req); const periodStart = parseDate(input.periodStart, 'periodStart'); const periodEnd = parseDate(input.periodEnd, 'periodEnd');
    if (periodEnd <= periodStart) throw new AppError(400, 'INVALID_RANGE', 'periodEnd must be after periodStart.');
    const result = transaction(() => {
      const existing = db.prepare(`SELECT * FROM timesheets WHERE organization_id=? AND membership_id=? AND period_start=? AND period_end=?`).get(actor.organization_id, actor.membership_id, periodStart, periodEnd);
      if (existing) return existing;
      const timesheet = { id:id(), organization_id:actor.organization_id, membership_id:actor.membership_id, period_start:periodStart, period_end:periodEnd, status:'draft', created_at:now() };
      db.prepare(`INSERT INTO timesheets(id,organization_id,membership_id,period_start,period_end,status,created_at) VALUES (?,?,?,?,?,'draft',?)`).run(timesheet.id,timesheet.organization_id,timesheet.membership_id,timesheet.period_start,timesheet.period_end,timesheet.created_at);
      audit(actor.organization_id,actor.membership_id,'timesheet.created','timesheet',timesheet.id);
      return timesheet;
    });
    return json(res, 201, result, requestId);
  }
  if (method === 'POST' && path === '/api/v1/corrections') {
    const input = await body(req); if (!Number.isInteger(input.deltaMinutes) || Math.abs(input.deltaMinutes) > 1440 || typeof input.reason !== 'string' || input.reason.trim().length < 5 || input.reason.length > 1000 || typeof input.sessionId !== 'string') throw new AppError(400, 'INVALID_INPUT', 'Provide a session, a correction between -24 and 24 hours, and a reason of at least five characters.');
    const session = db.prepare('SELECT * FROM work_sessions WHERE organization_id=? AND membership_id=? AND id=? AND ended_at IS NOT NULL').get(actor.organization_id, actor.membership_id, input.sessionId); if (!session) throw new AppError(404, 'NOT_FOUND', 'A completed session in your account is required.');
    const result = transaction(() => {
      const requestIdValue = id();
      db.prepare(`INSERT INTO correction_requests(id,organization_id,membership_id,work_session_id,requester_membership_id,delta_ms,reason,status,created_at)
        VALUES (?,?,?,?,?,?,?,'pending',?)`).run(requestIdValue, actor.organization_id, actor.membership_id, session.id, actor.membership_id, input.deltaMinutes * 60000, input.reason.trim(), now());
      audit(actor.organization_id, actor.membership_id, 'correction.requested', 'correction_request', requestIdValue, input.reason.trim());
      return { id: requestIdValue, status: 'pending' };
    });
    return json(res, 201, result, requestId);
  }
  if (method === 'GET' && path === '/api/v1/corrections') {
    requireRole(actor, ['manager', 'admin']);
    const status = url.searchParams.get('status') || 'pending'; if (!['pending','approved','rejected','clarification_requested'].includes(status)) throw new AppError(400, 'INVALID_STATUS', 'Invalid correction status.');
    const rows = db.prepare(`SELECT c.*,u.full_name AS employee_name FROM correction_requests c JOIN memberships m ON m.id=c.membership_id JOIN users u ON u.id=m.user_id
      WHERE c.organization_id=? AND c.status=? ORDER BY c.created_at`).all(actor.organization_id, status).filter((row) => canManage(actor, db.prepare('SELECT * FROM memberships WHERE id=?').get(row.membership_id)));
    return json(res, 200, { corrections: rows }, requestId);
  }
  const correctionMatch = path.match(/^\/api\/v1\/corrections\/([0-9a-f-]+)\/(approve|reject|clarify)$/);
  if (method === 'POST' && correctionMatch) {
    requireRole(actor, ['manager', 'admin']); const [, correctionId, action] = correctionMatch; const input = await body(req);
    const result = transaction(() => {
      const row = db.prepare('SELECT * FROM correction_requests WHERE organization_id=? AND id=?').get(actor.organization_id, correctionId);
      if (!row || !canManage(actor, db.prepare('SELECT * FROM memberships WHERE id=?').get(row.membership_id))) throw new AppError(404, 'NOT_FOUND', 'The requested correction was not found.');
      if (row.status !== 'pending') throw new AppError(409, 'INVALID_STATE', 'This correction has already been resolved.');
      if (row.requester_membership_id === actor.membership_id) throw new AppError(403, 'SELF_APPROVAL', 'You cannot approve your own correction.');
      if ((action === 'reject' || action === 'clarify') && (typeof input.reason !== 'string' || input.reason.trim().length < 3)) throw new AppError(400, 'REASON_REQUIRED', 'Provide a resolution reason.');
      const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'clarification_requested';
      const at = now(); db.prepare(`UPDATE correction_requests SET status=?,resolver_membership_id=?,resolution_reason=?,resolved_at=? WHERE id=? AND status='pending'`).run(status, actor.membership_id, input.reason?.trim() || null, at, row.id);
      if (action === 'approve') db.prepare(`INSERT INTO time_adjustments(id,organization_id,membership_id,work_session_id,correction_request_id,delta_ms,reason,actor_membership_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id(), actor.organization_id, row.membership_id, row.work_session_id, row.id, row.delta_ms, row.reason, actor.membership_id, at);
      audit(actor.organization_id, actor.membership_id, `correction.${action}`, 'correction_request', row.id, input.reason || row.reason);
      return { id: row.id, status };
    });
    return json(res, 200, result, requestId);
  }

  if (method === 'GET' && path === '/api/v1/team/attendance') {
    requireRole(actor, ['manager','admin']); const day = parseDate(url.searchParams.get('date') || new Date().toISOString().slice(0,10), 'date');
    const members = db.prepare(`SELECT m.id,m.role,m.manager_membership_id,u.full_name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.status='active' ORDER BY u.full_name`).all(actor.organization_id).filter((member) => member.id === actor.membership_id || canManage(actor, member));
    const list = members.map((member) => { const current = db.prepare('SELECT * FROM work_sessions WHERE organization_id=? AND membership_id=? AND ended_at IS NULL').get(actor.organization_id, member.id); const openBreak = current && db.prepare('SELECT * FROM breaks WHERE work_session_id=? AND ended_at IS NULL').get(current.id); return { membershipId: member.id, name: member.full_name, email: member.email, state: current ? openBreak ? 'on_break' : 'working' : 'clocked_out', startedAt: current?.started_at || null }; });
    return json(res, 200, { date: day, members: list, counts: { working: list.filter((x) => x.state === 'working').length, onBreak: list.filter((x) => x.state === 'on_break').length, clockedOut: list.filter((x) => x.state === 'clocked_out').length } }, requestId);
  }
  if (method === 'GET' && path === '/api/v1/timesheets/team') {
    requireRole(actor, ['manager','admin']); const from = parseDate(url.searchParams.get('from'), 'from'); const to = parseDate(url.searchParams.get('to'), 'to'); if (to < from) throw new AppError(400, 'INVALID_RANGE', 'to must not be before from.');
    if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366*86400000) throw new AppError(400,'RANGE_TOO_LARGE','Report date ranges are limited to 366 days.');
    const members = db.prepare(`SELECT m.*,u.full_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.status='active'`).all(actor.organization_id).filter((m) => canManage(actor, m));
    const report = members.map((member) => { const rows = sessionRows(actor.organization_id, member.id, from, to, actor.time_zone); return { membershipId: member.id, name: member.full_name, totals: totals(rows), sessions: rows }; });
    return json(res, 200, { from, to, members: report }, requestId);
  }
  if (method === 'GET' && path === '/api/v1/timesheets/review') {
    requireRole(actor, ['manager','admin']);
    const rows = db.prepare(`SELECT t.*,u.full_name AS employee_name FROM timesheets t JOIN memberships m ON m.id=t.membership_id JOIN users u ON u.id=m.user_id
      WHERE t.organization_id=? AND t.status IN ('submitted','rejected') ORDER BY t.period_end`).all(actor.organization_id).filter((row) => canManage(actor, db.prepare('SELECT * FROM memberships WHERE id=?').get(row.membership_id)));
    return json(res, 200, { timesheets: rows }, requestId);
  }
  const timesheetAction = path.match(new RegExp('^/api/v1/timesheets/([0-9a-f-]+)/(submit|approve|reject|reopen)$'));
  if (method === 'POST' && timesheetAction) {
    const [, timesheetId, action] = timesheetAction; const input = await body(req);
    const result = transaction(() => {
      const sheet = db.prepare('SELECT * FROM timesheets WHERE organization_id=? AND id=?').get(actor.organization_id, timesheetId);
      if (!sheet || (sheet.membership_id !== actor.membership_id && !canManage(actor, db.prepare('SELECT * FROM memberships WHERE id=?').get(sheet.membership_id)))) throw new AppError(404, 'NOT_FOUND', 'The requested timesheet was not found.');
      const at = now();
      if (action === 'submit') {
        if (sheet.membership_id !== actor.membership_id || !['draft','rejected'].includes(sheet.status)) throw new AppError(409, 'INVALID_STATE', 'This timesheet cannot be submitted.');
        if (activeWorkOverlappingPeriod(actor, sheet)) throw new AppError(409, 'ACTIVE_SESSION', 'End your active work session for this period before submitting this timesheet.');
        db.prepare(`UPDATE timesheets SET status='submitted',submitted_at=?,rejection_reason=NULL WHERE id=?`).run(at, sheet.id);
      } else {
        requireRole(actor, ['manager','admin']);
        if (sheet.membership_id === actor.membership_id) throw new AppError(403, 'SELF_APPROVAL', 'You cannot approve your own timesheet.');
        if (action === 'approve') {
          if (sheet.status !== 'submitted') throw new AppError(409, 'INVALID_STATE', 'Only submitted timesheets can be approved.');
          db.prepare(`UPDATE timesheets SET status='approved',approved_at=?,approved_by_membership_id=? WHERE id=? AND status='submitted'`).run(at, actor.membership_id, sheet.id);
        } else if (action === 'reject') {
          if (sheet.status !== 'submitted' || typeof input.reason !== 'string' || input.reason.trim().length < 3) throw new AppError(400, 'REASON_REQUIRED', 'A submitted timesheet and a reason of at least three characters are required.');
          db.prepare(`UPDATE timesheets SET status='rejected',rejection_reason=? WHERE id=? AND status='submitted'`).run(input.reason.trim(), sheet.id);
        } else {
          if (actor.role !== 'admin' || sheet.status !== 'approved' || typeof input.reason !== 'string' || input.reason.trim().length < 3) throw new AppError(403, 'REOPEN_DENIED', 'An administrator must provide a reason to reopen an approved timesheet.');
          db.prepare(`UPDATE timesheets SET status='rejected',approved_at=NULL,approved_by_membership_id=NULL,rejection_reason=? WHERE id=?`).run(`Reopened: ${input.reason.trim()}`, sheet.id);
        }
      }
      const state = db.prepare('SELECT status FROM timesheets WHERE id=?').get(sheet.id).status;
      audit(actor.organization_id, actor.membership_id, `timesheet.${action}`, 'timesheet', sheet.id, input.reason || null);
      return { id: sheet.id, status: state };
    });
    return json(res, 200, result, requestId);
  }
  if (method === 'GET' && path === '/api/v1/reports/attendance.csv') {
    requireRole(actor, ['manager','admin']); const from = parseDate(url.searchParams.get('from'), 'from'); const to = parseDate(url.searchParams.get('to'), 'to'); if (to < from) throw new AppError(400, 'INVALID_RANGE', 'to must not be before from.');
    if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366*86400000) throw new AppError(400,'RANGE_TOO_LARGE','Report date ranges are limited to 366 days.');
    const members = db.prepare(`SELECT m.*,u.full_name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.status='active'`).all(actor.organization_id).filter((m) => canManage(actor, m));
    const escape = (value) => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    const lines = [['employee','email','session_started_at','session_ended_at','raw_hours','unpaid_break_hours','payable_hours'].map(escape).join(',')];
    for (const member of members) for (const row of sessionRows(actor.organization_id, member.id, from, to, actor.time_zone)) lines.push([member.full_name,member.email,row.started_at,row.ended_at,(row.rawMs/3600000).toFixed(4),(row.unpaidBreakMs/3600000).toFixed(4),(row.payableMs/3600000).toFixed(4)].map(escape).join(','));
    res.writeHead(200, { 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':`attachment; filename="attendance-${from}-to-${to}.csv"`, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'X-Request-Id':requestId }); return res.end(lines.join('\r\n'));
  }
  if (method === 'GET' && path === '/api/v1/audit') {
    requireRole(actor, ['manager','admin']); const rawRows = db.prepare(`SELECT a.*,u.full_name AS actor_name FROM audit_events a LEFT JOIN memberships m ON m.id=a.actor_membership_id LEFT JOIN users u ON u.id=m.user_id WHERE a.organization_id=? ORDER BY a.occurred_at DESC LIMIT 500`).all(actor.organization_id);
    const rows = rawRows.filter((row) => actor.role === 'admin' || row.actor_membership_id === actor.membership_id || (row.actor_membership_id && canManage(actor, db.prepare('SELECT * FROM memberships WHERE id=?').get(row.actor_membership_id))));
    return json(res, 200, { events: rows }, requestId);
  }

  if (path.startsWith('/api/')) throw new AppError(404, 'NOT_FOUND', 'The requested route was not found.');
  return serveStatic(path, res, requestId);
}

async function serveStatic(path, res, requestId) {
  let target = resolve(publicDir, `.${decodeURIComponent(path)}`);
  if (!target.startsWith(publicDir + sep) && target !== publicDir) throw new AppError(403, 'FORBIDDEN', 'Invalid path.');
  try { const stat = await import('node:fs/promises').then((fs) => fs.stat(target)); if (stat.isDirectory()) target = resolve(target, 'index.html'); }
  catch { target = resolve(publicDir, 'index.html'); }
  try {
    const content = await readFile(target); const type = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon' }[extname(target)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type':type, 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Referrer-Policy':'strict-origin-when-cross-origin', 'Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'", 'X-Request-Id':requestId }); res.end(content);
  } catch { json(res, 404, { error: 'Not found' }, requestId); }
}

requireConfig();
export const server = createServer(async (req, res) => {
  const requestId = randomBytes(12).toString('hex');
  try { await route(req, res, requestId); }
  catch (error) { fail(res, error, requestId); }
});
server.listen(port, host, () => console.log(`Dayline listening on http://${host}:${port}`));
