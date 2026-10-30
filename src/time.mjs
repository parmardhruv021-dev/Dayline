export function validTimeZone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; } catch { return false; }
}

export function addCalendarDays(date, days) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new RangeError('Invalid calendar date.');
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function dateParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function localDateAt(instant, timeZone) {
  const parts = dateParts(instant instanceof Date ? instant : new Date(instant), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function localDateStart(date, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || addCalendarDays(date, 0) !== date) throw new RangeError('Invalid calendar date.');
  if (!validTimeZone(timeZone)) throw new RangeError('Invalid IANA time zone.');
  const [year, month, day] = date.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day);
  let candidate = desired;
  for (let i = 0; i < 6; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(candidate));
    const found = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(found.year, found.month - 1, found.day, found.hour, found.minute, found.second);
    const adjustment = desired - represented;
    if (adjustment === 0) break;
    candidate += adjustment;
  }
  // The chosen office dates begin at the first representable instant of the local date.
  // For the common daylight-saving change at 02:00, local midnight remains unambiguous.
  if (localDateAt(candidate, timeZone) !== date) throw new RangeError(`Local midnight for ${date} does not exist in ${timeZone}.`);
  return new Date(candidate).toISOString();
}

export function localDateRange(from, to, timeZone) {
  if (to < from) throw new RangeError('Range end precedes range start.');
  return { start: localDateStart(from, timeZone), end: localDateStart(addCalendarDays(to, 1), timeZone) };
}

export function clipInterval(start, end, rangeStart, rangeEnd) {
  const left = Math.max(Date.parse(start), Date.parse(rangeStart));
  const right = Math.min(Date.parse(end), Date.parse(rangeEnd));
  return { startMs: left, endMs: Math.max(left, right), durationMs: Math.max(0, right - left) };
}

export function sumSessionDurations(session, rangeStart, rangeEnd, now = Date.now()) {
  const sessionEnd = session.ended_at ? Date.parse(session.ended_at) : now;
  const clipped = clipInterval(session.started_at, new Date(sessionEnd).toISOString(), rangeStart, rangeEnd);
  const rawMs = clipped.durationMs;
  let unpaidBreakMs = 0;
  for (const item of session.breaks || []) {
    if (item.paid) continue;
    const breakEnd = item.ended_at ? Date.parse(item.ended_at) : now;
    const left = Math.max(clipped.startMs, Date.parse(item.started_at));
    const right = Math.min(clipped.endMs, breakEnd);
    unpaidBreakMs += Math.max(0, right - left);
  }
  return { rawMs, unpaidBreakMs, payableMs: Math.max(0, rawMs - unpaidBreakMs) };
}
