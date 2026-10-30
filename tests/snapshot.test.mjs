import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let directory;
let databasePath;
let origin;
let child;

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function login(email) {
  const response = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email, password: 'Demo-only-Change-Me-2026!' }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.get('set-cookie').split(';')[0];
}

async function request(cookie, path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${origin}${path}`, { method, headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

// A valid 1x1 PNG frame used as a stand-in captured screen.
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'dayline-snap-'));
  databasePath = join(directory, 'snapshots.sqlite');
  const env = { ...process.env, NODE_ENV: 'development', DATABASE_PATH: databasePath, ORG_TIME_ZONE: 'America/Los_Angeles' };
  execFileSync(process.execPath, ['scripts/seed.mjs'], { cwd: process.cwd(), env, stdio: 'ignore' });
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/server.mjs'], { cwd: process.cwd(), env: { ...env, PORT: String(port), HOST: '127.0.0.1', SESSION_SECRET: 'snapshot-test-secret-at-least-32-bytes' }, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited with code ${child.exitCode}`);
    try { const response = await fetch(`${origin}/health/ready`); if (response.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'HTTP server did not become ready');
});

after(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('snapshot policy is admin-only and validated', async () => {
  const employee = await login('employee2@dayline.test');
  const denied = await request(employee, '/api/v1/organization/policies', { method: 'PATCH', body: { snapshotsEnabled: true } });
  assert.equal(denied.status, 403);

  const admin = await login('admin@dayline.test');
  const badRange = await request(admin, '/api/v1/organization/policies', { method: 'PATCH', body: { snapshotMinIntervalSeconds: 100, snapshotMaxIntervalSeconds: 50 } });
  assert.equal(badRange.status, 400);
  const badType = await request(admin, '/api/v1/organization/policies', { method: 'PATCH', body: { snapshotsEnabled: 'yes' } });
  assert.equal(badType.status, 400);

  const patched = await request(admin, '/api/v1/organization/policies', { method: 'PATCH', body: { snapshotsEnabled: true, snapshotMinIntervalSeconds: 30, snapshotMaxIntervalSeconds: 60, snapshotRetentionDays: 7 } });
  assert.equal(patched.status, 200, await patched.clone().text());
  const saved = (await patched.json()).data;
  assert.equal(saved.snapshotsEnabled, true);
  assert.equal(saved.snapshotMinIntervalSeconds, 30);
  assert.equal(saved.snapshotRetentionDays, 7);

  const events = (await (await request(admin, '/api/v1/audit')).json()).data.events;
  assert.ok(events.some((event) => event.action === 'organization.policy_updated'));
});

test('captures require an enabled policy, an active session and respect the server interval', async () => {
  const employee = await login('employee2@dayline.test');
  const admin = await login('admin@dayline.test');

  // Disabled policy refuses capture even while clocked in.
  await request(admin, '/api/v1/organization/policies', { method: 'PATCH', body: { snapshotsEnabled: false } });
  const clockIn = await request(employee, '/api/v1/attendance/clock-in', { method: 'POST', headers: { 'Idempotency-Key': 'snap-clock-in-0001' } });
  assert.equal(clockIn.status, 200, await clockIn.clone().text());
  const disabled = await request(employee, '/api/v1/attendance/snapshots', { method: 'POST', body: { image: PIXEL_PNG, contentType: 'image/png', width: 1, height: 1 } });
  assert.equal(disabled.status, 409);
  assert.equal((await disabled.json()).error.code, 'SNAPSHOT_DISABLED');

  const enabled = await request(admin, '/api/v1/organization/policies', { method: 'PATCH', body: { snapshotsEnabled: true } });
  assert.equal(enabled.status, 200, await enabled.clone().text());

  const config = await request(employee, '/api/v1/snapshots/config');
  assert.equal(config.status, 200);
  const configData = (await config.json()).data;
  assert.equal(configData.enabled, true);
  assert.equal(configData.sessionOpen, true);
  assert.ok(configData.firstDueAt, 'server issues a first due time derived from the session');

  const first = await request(employee, '/api/v1/attendance/snapshots', { method: 'POST', body: { image: PIXEL_PNG, contentType: 'image/png', width: 1, height: 1 } });
  assert.equal(first.status, 201, await first.clone().text());
  const firstData = (await first.json()).data;
  assert.equal(firstData.status, 'captured');
  assert.ok(Date.parse(firstData.nextDueAt) > Date.now());

  // A second capture before the server-issued due time is refused.
  const early = await request(employee, '/api/v1/attendance/snapshots', { method: 'POST', body: { image: PIXEL_PNG, contentType: 'image/png', width: 1, height: 1 } });
  assert.equal(early.status, 429);
  assert.equal((await early.json()).error.code, 'SNAPSHOT_TOO_SOON');

  // Oversized and unknown media types are refused.
  const badType = await request(employee, '/api/v1/attendance/snapshots', { method: 'POST', body: { image: PIXEL_PNG, contentType: 'text/html' } });
  assert.equal(badType.status, 400);
  const oversized = await request(employee, '/api/v1/attendance/snapshots', { method: 'POST', body: { image: 'A'.repeat(600 * 1024) } });
  assert.equal(oversized.status, 413);

  // Capture pauses while on a break.
  await request(employee, '/api/v1/attendance/breaks/start', { method: 'POST', headers: { 'Idempotency-Key': 'snap-break-start-01' } });
  const onBreak = await request(employee, '/api/v1/attendance/snapshots', { method: 'POST', body: { image: PIXEL_PNG, contentType: 'image/png', width: 1, height: 1 } });
  assert.equal(onBreak.status, 409);
  assert.equal((await onBreak.json()).error.code, 'ON_BREAK');
  await request(employee, '/api/v1/attendance/breaks/end', { method: 'POST', headers: { 'Idempotency-Key': 'snap-break-end-001' } });

  // Declined screen-share permission is recorded honestly, once per session.
  const unavailable = await request(employee, '/api/v1/attendance/snapshots', { method: 'POST', body: { status: 'capture_unavailable' } });
  assert.ok([201, 429].includes(unavailable.status), await unavailable.clone().text());

  // Stop the session; captures now require an active session again.
  const clockOut = await request(employee, '/api/v1/attendance/clock-out', { method: 'POST', headers: { 'Idempotency-Key': 'snap-clock-out-001' } });
  assert.equal(clockOut.status, 200, await clockOut.clone().text());
  const afterOut = await request(employee, '/api/v1/attendance/snapshots', { method: 'POST', body: { image: PIXEL_PNG, contentType: 'image/png', width: 1, height: 1 } });
  assert.equal(afterOut.status, 409);
  assert.equal((await afterOut.json()).error.code, 'NOT_CLOCKED_IN');
});

test('snapshot images are visible only to the owner and authorized managers', async () => {
  const employee = await login('employee2@dayline.test');
  const peer = await login('employee@dayline.test');
  const manager = await login('manager@dayline.test');

  const list = await request(employee, '/api/v1/attendance/snapshots');
  assert.equal(list.status, 200);
  const snapshots = (await list.json()).data.snapshots;
  assert.ok(snapshots.length >= 1, 'at least one stored snapshot');
  const snapshot = snapshots.find((row) => row.status === 'captured');
  assert.ok(snapshot, 'a captured snapshot exists');
  assert.equal(snapshot.hasImage, true);

  const owner = await request(employee, `/api/v1/snapshots/${snapshot.id}/image`);
  assert.equal(owner.status, 200);
  assert.match(owner.headers.get('content-type'), /image\/png/);

  const managerRead = await request(manager, `/api/v1/snapshots/${snapshot.id}/image`);
  assert.equal(managerRead.status, 200);

  const peerRead = await request(peer, `/api/v1/snapshots/${snapshot.id}/image`);
  assert.equal(peerRead.status, 404, 'another employee cannot read the frame');

  const managerList = await request(manager, `/api/v1/attendance/snapshots?membershipId=${encodeURIComponent((await (await request(employee, '/api/v1/auth/me')).json()).data.membership.id)}`);
  assert.equal(managerList.status, 200);
  assert.ok((await managerList.json()).data.snapshots.length >= 1);

  const peerList = await request(peer, '/api/v1/attendance/snapshots?membershipId=' + encodeURIComponent((await (await request(employee, '/api/v1/auth/me')).json()).data.membership.id));
  assert.equal(peerList.status, 403, 'a peer cannot list another employee snapshots');

  const crossTenant = await request(employee, '/api/v1/snapshots/00000000-0000-0000-0000-000000000000/image');
  assert.equal(crossTenant.status, 404);
});