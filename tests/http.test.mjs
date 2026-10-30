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
  const server=createServer();
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const {port}=server.address(); await new Promise(resolve=>server.close(resolve)); return port;
}

async function login(email) {
  const response=await fetch(`${origin}/api/v1/auth/login`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({email,password:'Demo-only-Change-Me-2026!'})});
  assert.equal(response.status,200,await response.clone().text());
  return response.headers.get('set-cookie').split(';')[0];
}

async function request(cookie,path,{method='GET',body,headers={}}={}) {
  return fetch(`${origin}${path}`,{method,headers:{Cookie:cookie,Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}

before(async()=>{
  directory=mkdtempSync(join(tmpdir(),'dayline-http-'));
  databasePath=join(directory,'integration.sqlite');
  const env={...process.env,NODE_ENV:'development',DATABASE_PATH:databasePath,ORG_TIME_ZONE:'America/Los_Angeles'};
  execFileSync(process.execPath,['scripts/seed.mjs'],{cwd:process.cwd(),env,stdio:'ignore'});
  const port=await unusedPort(); origin=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),env:{...env,PORT:String(port),HOST:'127.0.0.1',SESSION_SECRET:'integration-test-secret-at-least-32-bytes'},stdio:'ignore'});
  let ready=false;
  for(let i=0;i<50;i++) {
    if(child.exitCode!==null) throw new Error(`Test server exited with code ${child.exitCode}`);
    try { const response=await fetch(`${origin}/health/ready`); if(response.ok){ready=true;break;} } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(ready,true,'HTTP server did not become ready');
});

after(async()=>{
  if(child && child.exitCode===null) { child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve)); }
  if(directory) rmSync(directory,{recursive:true,force:true});
});

test('HTTP employee and manager journeys persist time, corrections, approvals and scoped reports',async()=>{
  const employee=await login('employee2@dayline.test');
  const unauthorized=await request(employee,'/api/v1/team/attendance'); assert.equal(unauthorized.status,403);
  const foreign=await fetch(`${origin}/api/v1/attendance/clock-in`,{method:'POST',headers:{Cookie:employee,Origin:'https://attacker.invalid','Idempotency-Key':'foreign-origin-key'}});assert.equal(foreign.status,403);
  const current=await request(employee,'/api/v1/attendance/current');assert.equal(current.status,200);assert.equal((await current.json()).data.state,'clocked_out');
  const clockIn=await request(employee,'/api/v1/attendance/clock-in',{method:'POST',headers:{'Idempotency-Key':'http-clock-in-key-01'}});assert.equal(clockIn.status,200);const started=(await clockIn.json()).data;
  const replay=await request(employee,'/api/v1/attendance/clock-in',{method:'POST',headers:{'Idempotency-Key':'http-clock-in-key-01'}});assert.equal(replay.status,200);assert.equal((await replay.json()).data.sessionId,started.sessionId);
  assert.equal((await request(employee,'/api/v1/attendance/breaks/start',{method:'POST',headers:{'Idempotency-Key':'http-break-start-001'},body:{paid:true}})).status,200);
  const policy=await request(employee,'/api/v1/organization/policies');assert.equal((await policy.json()).data.breaksPaid,false);
  assert.equal((await request(employee,'/api/v1/organization/policies',{method:'PATCH',body:{breaksPaid:true}})).status,403);
  const admin=await login('admin@dayline.test');
  assert.equal((await request(admin,'/api/v1/organization/policies',{method:'PATCH',body:{breaksPaid:true}})).status,200);
  const activeState=await request(employee,'/api/v1/attendance/current');assert.equal((await activeState.json()).data.session.breaks[0].paid,false);
  assert.equal((await request(employee,'/api/v1/attendance/clock-out',{method:'POST',headers:{'Idempotency-Key':'http-clock-out-open-01'}})).status,409);
  const dayParts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(started.startedAt));
  const day=`${dayParts.find(p=>p.type==='year').value}-${dayParts.find(p=>p.type==='month').value}-${dayParts.find(p=>p.type==='day').value}`;
  const next=new Date(`${day}T12:00:00.000Z`);next.setUTCDate(next.getUTCDate()+1);const periodEnd=next.toISOString().slice(0,10);
  const activeTimesheet=await request(employee,'/api/v1/timesheets',{method:'POST',body:{periodStart:day,periodEnd}});assert.equal(activeTimesheet.status,201);const activeSheet=(await activeTimesheet.json()).data;
  assert.equal((await request(employee,`/api/v1/timesheets/${activeSheet.id}/submit`,{method:'POST',body:{}})).status,409);
  assert.equal((await request(employee,'/api/v1/attendance/breaks/end',{method:'POST',headers:{'Idempotency-Key':'http-break-end-001'}})).status,200);
  assert.equal((await request(employee,'/api/v1/attendance/clock-out',{method:'POST',headers:{'Idempotency-Key':'http-clock-out-end-01'}})).status,200);
  const timesheet=await request(employee,'/api/v1/timesheets',{method:'POST',body:{periodStart:day,periodEnd}});assert.equal(timesheet.status,201);const sheet=(await timesheet.json()).data;
  assert.equal((await request(employee,`/api/v1/timesheets/${sheet.id}/submit`,{method:'POST',body:{}})).status,200);
  const mine=await request(employee,`/api/v1/timesheets/me?from=${day}&to=${day}`);assert.equal(mine.status,200);assert.equal((await mine.json()).data.sessions.length,1);
  const correction=await request(employee,'/api/v1/corrections',{method:'POST',body:{sessionId:started.sessionId,deltaMinutes:5,reason:'Forgot to start on time'}});assert.equal(correction.status,201);const correctionData=(await correction.json()).data;

  const manager=await login('manager@dayline.test');
  const team=await request(manager,`/api/v1/team/attendance?date=${day}`);assert.equal(team.status,200);const members=(await team.json()).data.members;assert.ok(members.some(m=>m.email==='employee2@dayline.test'));
  const queue=await request(manager,'/api/v1/corrections?status=pending');assert.equal(queue.status,200);assert.ok((await queue.json()).data.corrections.some(c=>c.id===correctionData.id));
  assert.equal((await request(manager,`/api/v1/corrections/${correctionData.id}/approve`,{method:'POST',body:{}})).status,200);
  assert.equal((await request(manager,`/api/v1/timesheets/${sheet.id}/approve`,{method:'POST',body:{}})).status,200);
  const afterCorrection=await request(employee,'/api/v1/corrections/mine');assert.equal((await afterCorrection.json()).data.corrections[0].status,'approved');
  const reviewed=await request(manager,'/api/v1/timesheets/review');assert.equal(reviewed.status,200);assert.equal((await reviewed.json()).data.timesheets.length,0);
  const csv=await request(manager,`/api/v1/reports/attendance.csv?from=${day}&to=${day}`);assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);const csvText=await csv.text();assert.match(csvText,/employee2@dayline\.test/);assert.match(csvText,/payable_hours/);
  assert.equal((await request(employee,'/api/v1/audit')).status,403);
  assert.equal((await request(employee,'/api/v1/auth/logout',{method:'POST'})).status,200);
  assert.equal((await request(employee,'/api/v1/attendance/current')).status,401);
});
