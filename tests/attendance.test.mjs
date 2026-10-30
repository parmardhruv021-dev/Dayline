import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localDateAt } from '../src/time.mjs';

let temporary;
let db;
let clock;
let breakAction;
let currentState;
let sessionRows;
let AppError;
let actor;
let manager;
let otherOrgActor;
let ids;
let sessions;

before(async () => {
  temporary = mkdtempSync(join(tmpdir(),'dayline-test-'));
  process.env.DATABASE_PATH = join(temporary,'test.sqlite');
  const database = await import('../src/db.mjs'); db = database.db;
  ({clock,breakAction,currentState,sessionRows,AppError} = await import('../src/attendance.mjs'));
});

after(() => { try { db?.close(); } finally { if (temporary) rmSync(temporary,{recursive:true,force:true}); } });

beforeEach(() => {
  db.exec('PRAGMA foreign_keys = OFF; DELETE FROM idempotency_results; DELETE FROM attendance_events; DELETE FROM breaks; DELETE FROM correction_requests; DELETE FROM time_adjustments; DELETE FROM timesheets; DELETE FROM work_sessions; DELETE FROM audit_events; DELETE FROM auth_sessions; DELETE FROM memberships; DELETE FROM users; DELETE FROM organizations; PRAGMA foreign_keys = ON;');
  const org='org-test', org2='org-other', user='user-test', managerUser='user-manager', outsider='user-outsider', member='member-test', managerId='member-manager', otherMember='member-other';
  db.prepare('INSERT INTO organizations(id,name,time_zone,created_at) VALUES (?,?,?,?)').run(org,'Test Org','America/Los_Angeles',new Date().toISOString());
  db.prepare('INSERT INTO organizations(id,name,time_zone,created_at) VALUES (?,?,?,?)').run(org2,'Other Org','UTC',new Date().toISOString());
  for (const [id,email,name] of [[user,'user@test.invalid','Test Employee'],[managerUser,'manager@test.invalid','Test Manager'],[outsider,'outside@test.invalid','Other Org']]) db.prepare('INSERT INTO users(id,email,full_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(id,email,name,'x:y',new Date().toISOString());
  db.prepare('INSERT INTO memberships(id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,?)').run(managerId,org,managerUser,'manager',new Date().toISOString());
  db.prepare('INSERT INTO memberships(id,organization_id,user_id,role,manager_membership_id,created_at) VALUES (?,?,?,?,?,?)').run(member,org,user,'employee',managerId,new Date().toISOString());
  db.prepare('INSERT INTO memberships(id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,?)').run(otherMember,org2,outsider,'employee',new Date().toISOString());
  actor={organization_id:org,membership_id:member,role:'employee'}; manager={organization_id:org,membership_id:managerId,role:'manager'}; otherOrgActor={organization_id:org2,membership_id:otherMember,role:'employee'};
  ids={org,org2,member,managerId,otherMember}; sessions={};
});

test('clock-in is persisted, duplicate session is rejected, and same-key replay returns original response', () => {
  const first=clock(actor,'in','clock-in-key-001');
  assert.equal(first.state,'working');
  const replay=clock(actor,'in','clock-in-key-001');
  assert.deepEqual(replay,first);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attendance_events WHERE kind=\'clock_in\'').get().count,1);
  assert.throws(()=>clock(actor,'in','clock-in-key-002'),(error)=>error instanceof AppError&&error.code==='ALREADY_CLOCKED_IN');
  assert.equal(currentState(actor).state,'working');
});

test('break lifecycle disallows clock-out while open and deducts unpaid time once', () => {
  const started=clock(actor,'in','session-clock-in-01'); sessions.active=started.sessionId;
  breakAction(actor,'start','session-break-on-01');
  assert.equal(currentState(actor).state,'on_break');
  assert.throws(()=>clock(actor,'out','session-clock-out-1'),(error)=>error.code==='BREAK_STILL_OPEN');
  const open=db.prepare('SELECT started_at FROM breaks WHERE work_session_id=?').get(sessions.active);
  const later=new Date(Date.parse(open.started_at)+2_000).toISOString();
  db.prepare('UPDATE breaks SET ended_at=? WHERE work_session_id=?').run(later,sessions.active);
  const ended=new Date(Date.parse(later)+3_000).toISOString();
  db.prepare('UPDATE work_sessions SET ended_at=? WHERE id=?').run(ended,sessions.active);
  const day=localDateAt(open.started_at,'America/Los_Angeles');
  const summary=sessionRows(ids.org,ids.member,day,day,'America/Los_Angeles')[0];
  assert.equal(summary.unpaidBreakMs,2_000);
  assert.equal(summary.payableMs,Date.parse(ended)-Date.parse(summary.started_at)-2_000);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attendance_events WHERE kind=\'break_start\'').get().count,1);
});

test('idempotency key reuse with different operation is rejected', () => {
  clock(actor,'in','same-idempotency-key');
  assert.throws(()=>breakAction(actor,'start','same-idempotency-key'),(error)=>error.code==='IDEMPOTENCY_KEY_REUSED');
});

test('paid-break compensation comes from organization policy, not request data', () => {
  const started=clock(actor,'in','paid-policy-clock-in');
  db.prepare('UPDATE organizations SET breaks_paid=1 WHERE id=?').run(ids.org);
  const result=breakAction(actor,'start','paid-policy-break');
  assert.equal(result.paid,true);
  assert.equal(db.prepare('SELECT paid FROM breaks WHERE work_session_id=?').get(started.sessionId).paid,1);
});

test('composite membership/session constraints prevent cross-organization references', () => {
  const session=clock(actor,'in','tenant-safety-key').sessionId;
  assert.throws(()=>db.prepare(`INSERT INTO attendance_events(id,organization_id,membership_id,work_session_id,actor_membership_id,kind,occurred_at,recorded_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)`).run('evt-cross',ids.org2,ids.otherMember,session,ids.otherMember,'clock_in',new Date().toISOString(),new Date().toISOString(),'cross-key'));
});
