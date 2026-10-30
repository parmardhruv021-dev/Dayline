import { scrypt as scryptCallback, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { db, id, now, transaction, audit } from '../src/db.mjs';

if (process.env.NODE_ENV !== 'development') throw new Error('Seed is restricted to NODE_ENV=development.');
const scrypt = promisify(scryptCallback);
const password = process.env.DEMO_PASSWORD || 'Demo-only-Change-Me-2026!';
const salt = randomBytes(16).toString('hex');
const hash = `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;

transaction(() => {
  const org = db.prepare('SELECT id FROM organizations WHERE name=?').get('Northstar Office (DEMO)');
  const orgId = org?.id || id();
  if (!org) db.prepare('INSERT INTO organizations(id,name,time_zone,week_starts_on,created_at) VALUES (?,?,?,?,?)').run(orgId, 'Northstar Office (DEMO)', process.env.ORG_TIME_ZONE || 'America/Los_Angeles', 1, now());
  const seeds = [
    ['admin@dayline.test','Avery Admin','admin'],
    ['manager@dayline.test','Morgan Manager','manager'],
    ['employee@dayline.test','Riley Employee','employee'],
    ['employee2@dayline.test','Casey Employee','employee'],
  ];
  const memberships = {};
  for (const [email,name,role] of seeds) {
    let user = db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email); const userId = user?.id || id();
    if (!user) db.prepare('INSERT INTO users(id,email,full_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(userId,email,name,hash,now());
    else db.prepare('UPDATE users SET full_name=?,password_hash=?,status=\'active\' WHERE id=?').run(name,hash,userId);
    const member = db.prepare('SELECT id FROM memberships WHERE organization_id=? AND user_id=?').get(orgId,userId); const memberId = member?.id || id();
    if (!member) db.prepare('INSERT INTO memberships(id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,?)').run(memberId,orgId,userId,role,now());
    else db.prepare('UPDATE memberships SET role=?,status=\'active\' WHERE id=?').run(role,memberId);
    memberships[email] = memberId;
  }
  db.prepare('UPDATE memberships SET manager_membership_id=? WHERE organization_id=? AND id IN (?,?)').run(memberships['manager@dayline.test'],orgId,memberships['employee@dayline.test'],memberships['employee2@dayline.test']);
  const manager = db.prepare('SELECT manager_membership_id FROM memberships WHERE id=?').get(memberships['employee@dayline.test']);
  if (manager.manager_membership_id !== memberships['manager@dayline.test']) throw new Error('Demo manager assignment failed.');
  const employeeId = memberships['employee@dayline.test'];
  if (!db.prepare('SELECT 1 FROM work_sessions WHERE organization_id=? AND membership_id=?').get(orgId, employeeId)) {
    const start = new Date(Date.now()-4*60*60*1000).toISOString(); const breakStart = new Date(Date.now()-90*60*1000).toISOString(); const breakEnd = new Date(Date.now()-60*60*1000).toISOString(); const sessionId = id();
    db.prepare('INSERT INTO work_sessions(id,organization_id,membership_id,started_at,created_at) VALUES (?,?,?,?,?)').run(sessionId,orgId,employeeId,start,start);
    const addEvent = (kind,at,key) => db.prepare(`INSERT INTO attendance_events(id,organization_id,membership_id,work_session_id,actor_membership_id,kind,occurred_at,recorded_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)`).run(id(),orgId,employeeId,sessionId,employeeId,kind,at,at,key);
    addEvent('clock_in',start,`seed-${sessionId}-in`);
    const breakId = id(); db.prepare('INSERT INTO breaks(id,organization_id,work_session_id,started_at,ended_at,paid) VALUES (?,?,?,?,?,0)').run(breakId,orgId,sessionId,breakStart,breakEnd); addEvent('break_start',breakStart,`seed-${sessionId}-break-in`); addEvent('break_end',breakEnd,`seed-${sessionId}-break-out`);
    audit(orgId,memberships['admin@dayline.test'],'demo.seeded','work_session',sessionId,'Explicit development seed');
  }
});
console.log('Development demo environment seeded. Test accounts: admin@dayline.test, manager@dayline.test, employee@dayline.test, employee2@dayline.test');
console.log('Use DEMO_PASSWORD to configure the shared development-only password. Never use demo accounts in production.');
