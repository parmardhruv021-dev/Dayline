import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, localDateAt, localDateRange, localDateStart, sumSessionDurations } from '../src/time.mjs';

test('calendar day addition validates and crosses year boundaries', () => {
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.throws(() => addCalendarDays('2026-02-30', 0), /Invalid/);
});

test('local date boundaries use the IANA zone across spring DST', () => {
  const day = localDateRange('2026-03-08','2026-03-08','America/Los_Angeles');
  assert.equal(Date.parse(day.end)-Date.parse(day.start),23*60*60*1000);
  assert.equal(localDateAt(day.start,'America/Los_Angeles'),'2026-03-08');
});

test('local date boundaries use the IANA zone across autumn DST', () => {
  const day = localDateRange('2026-11-01','2026-11-01','America/Los_Angeles');
  assert.equal(Date.parse(day.end)-Date.parse(day.start),25*60*60*1000);
  assert.equal(localDateStart('2026-11-01','America/Los_Angeles'),'2026-11-01T07:00:00.000Z');
});

test('duration calculation clips shift and deducts only unpaid break overlap', () => {
  const result = sumSessionDurations({
    started_at:'2026-10-26T23:00:00.000Z', ended_at:'2026-10-27T03:00:00.000Z',
    breaks:[
      {started_at:'2026-10-27T00:00:00.000Z',ended_at:'2026-10-27T00:30:00.000Z',paid:false},
      {started_at:'2026-10-27T01:00:00.000Z',ended_at:'2026-10-27T01:15:00.000Z',paid:true},
    ],
  },'2026-10-27T00:00:00.000Z','2026-10-28T00:00:00.000Z');
  assert.deepEqual(result,{rawMs:3*60*60*1000,unpaidBreakMs:30*60*1000,payableMs:2.5*60*60*1000});
});
