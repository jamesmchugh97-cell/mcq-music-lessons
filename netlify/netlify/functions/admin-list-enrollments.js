// admin-list-enrollments.js
// Netlify serverless function: shows James who is booked in, for the
// "Who's booked in" section of the admin page. Read-only - it never changes
// anything.
//
// It pulls together:
//   - the regular students hard-coded in the booking system (the roster in
//     reserve-multi-slots.js - the one place that list lives),
//   - everyone enrolled online (weekly or fortnightly), and
//   - upcoming single lessons and packages booked online,
// and turns that into a day-by-day schedule with the free gaps and the
// start times where a full hour fits, using the same spacing rule as the
// rest of the site (lessons back to back, or at least 30 minutes apart).
//
// It also warns about anything that looks double-counted, e.g. a student who
// is both in the hard-coded roster AND enrolled online (which would block
// their slot twice, and keep it blocked after they cancel).
//
// Password-protected with the same ADMIN_PASSWORD and lockout as the other
// admin tools.
const { getStore } = require('@netlify/blobs');
const { listAllSubscriptions, timeToMinutes } = require('./subscription-helpers');
const { RECURRING_STUDENTS, SCHOOL_HOLIDAY_RANGES } = require('./reserve-multi-slots');
const { listVouchers, lessonsRemaining } = require('./voucher-helpers');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const OPEN_MINUTES = 12 * 60;
const MON_THU_CLOSE = 21 * 60;
const FRI_CLOSE = 16 * 60 + 30;
const MIN_GAP_MINUTES = 30;

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;
const ATTEMPT_WINDOW_MINUTES = 15;

function store(name) {
  return getStore({ name: name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

function getCallerIp(event) {
  const headers = event.headers || {};
  return headers['x-nf-client-connection-ip'] || headers['client-ip'] || (headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

async function isLockedOut(ip) {
  const record = await store('admin-auth-attempts').get('ip_' + ip, { type: 'json' });
  const now = Date.now();
  if (record && record.lockedUntil && record.lockedUntil > now) {
    return { locked: true, minutesLeft: Math.ceil((record.lockedUntil - now) / 60000) };
  }
  return { locked: false };
}

async function recordFailedAttempt(ip) {
  const s = store('admin-auth-attempts');
  const key = 'ip_' + ip;
  const now = Date.now();
  let record = await s.get(key, { type: 'json' });
  if (!record || !record.windowStart || (now - record.windowStart) > ATTEMPT_WINDOW_MINUTES * 60 * 1000) {
    record = { windowStart: now, failedCount: 0 };
  }
  record.failedCount = (record.failedCount || 0) + 1;
  if (record.failedCount >= MAX_FAILED_ATTEMPTS) record.lockedUntil = now + LOCKOUT_MINUTES * 60 * 1000;
  await s.set(key, JSON.stringify(record));
}

async function clearFailedAttempts(ip) {
  try { await store('admin-auth-attempts').delete('ip_' + ip); } catch (e) {}
}

// Today's date in Melbourne (the server itself runs in UTC, which is a
// different calendar day for the first 11 hours of every Melbourne day).
function melbourneToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dowOf(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function isSchoolHoliday(dateStr) {
  return (SCHOOL_HOLIDAY_RANGES || []).some(r => dateStr >= r[0] && dateStr <= r[1]);
}

// The next 14 days as an agenda: real dated lessons where they exist, plus
// each student's usual slot where they don't:
//   - bookings (single lessons, packages, and the next paid lesson of each
//     enrolled student) are definite and shown as they are;
//   - hard-coded regulars come every week (they have no dated records);
//   - enrolled students' later weeks are projected from their weekly or
//     fortnightly pattern, but only AFTER their last booked lesson, so a
//     lesson that was cancelled is not brought back, and a paused
//     enrollment shows nothing.
function buildAgenda(todayStr, bookingRecords, subscriptionRecords) {
  const days = [];
  for (let i = 0; i < 14; i++) days.push(addDays(todayStr, i));
  const byDate = {};
  days.forEach(d => { byDate[d] = []; });

  bookingRecords.forEach(rec => {
    if (!byDate[rec.date] || rec.pendingPayment === true || !rec.time) return;
    const start = timeToMinutes(rec.time);
    const dur = rec.duration || 45;
    byDate[rec.date].push({
      start: start, end: start + dur, name: rec.name || '(no name)',
      source: rec.subscriptionId ? 'enrolled online' : (rec.bookingType === 'package' ? 'package lesson' : 'single lesson'),
      projected: false
    });
  });

  days.forEach(date => {
    const dow = dowOf(date);
    (RECURRING_STUDENTS || []).forEach(r => {
      if (r.dow !== dow) return;
      if (r.pauseForHolidays && isSchoolHoliday(date)) return;
      if (r.frequency === 'fortnightly' && r.anchorDate && daysBetween(r.anchorDate, date) % 14 !== 0) return;
      const start = timeToMinutes(r.time);
      byDate[date].push({ start: start, end: start + r.duration, name: r.name, source: 'regular', projected: false });
    });
  });

  subscriptionRecords.forEach(rec => {
    if (rec.status !== 'active' || !rec.time) return;
    const dow = parseInt(rec.dayOfWeek, 10);
    const start = timeToMinutes(rec.time);
    const dur = parseInt(rec.durationMinutes, 10) || 45;
    days.forEach(date => {
      if (dowOf(date) !== dow) return;
      if (rec.startDate && date < rec.startDate) return;
      if (rec.nextLessonDate && date <= rec.nextLessonDate) return; // that week is covered by its booking (or was cancelled)
      if (rec.frequency === 'fortnightly' && rec.nextLessonDate && daysBetween(rec.nextLessonDate, date) % 14 !== 0) return;
      byDate[date].push({ start: start, end: start + dur, name: rec.studentName || '(no name)', source: 'enrolled online', projected: true });
    });
  });

  return days
    .filter(date => { const w = dowOf(date); return (w >= 1 && w <= 5) || byDate[date].length > 0; })
    .map(date => ({
      date: date,
      lessons: byDate[date].sort((a, b) => a.start - b.start).map(it => ({
        from: fmt(it.start), to: fmt(it.end), startMinutes: it.start, endMinutes: it.end,
        minutes: it.end - it.start, name: it.name, source: it.source, projected: it.projected
      }))
    }));
}

function fail(status, message) {
  return { statusCode: status, body: JSON.stringify({ success: false, error: message }) };
}

function fmt(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ap = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

// Only treated as the same person when the names match exactly (the
// hard-coded roster only has first names). Matching on first name alone
// wrongly paired two different people who share one, like the two Nicks.
// A same-time duplicate is caught separately by the overlap check.
function samePerson(a, b) {
  const norm = (n) => String(n || '').trim().toLowerCase();
  return norm(a) !== '' && norm(a) === norm(b);
}

// One day's schedule: who is in it, where the free gaps are, and every start
// time at which a full hour fits.
function buildDay(dow, items) {
  const close = dow === 5 ? FRI_CLOSE : MON_THU_CLOSE;
  const sorted = items.slice().sort((a, b) => a.start - b.start);
  const gaps = [];
  let cur = OPEN_MINUTES;
  sorted.forEach(it => {
    if (it.start > cur) gaps.push({ from: fmt(cur), to: fmt(it.start), minutes: it.start - cur });
    cur = Math.max(cur, it.end);
  });
  if (cur < close) gaps.push({ from: fmt(cur), to: fmt(close), minutes: close - cur });

  const hourStarts = [];
  for (let s = OPEN_MINUTES; s + 60 <= close; s += 15) {
    const e = s + 60;
    let ok = true;
    for (const it of sorted) {
      if (s < it.end && it.start < e) { ok = false; break; }
      const before = s - it.end;
      const after = it.start - e;
      if ((before > 0 && before < MIN_GAP_MINUTES) || (after > 0 && after < MIN_GAP_MINUTES)) { ok = false; break; }
    }
    if (ok) hourStarts.push(s);
  }
  // collapse consecutive start times into ranges for readability
  const ranges = [];
  hourStarts.forEach(s => {
    const last = ranges[ranges.length - 1];
    if (last && s === last.to + 15) last.to = s; else ranges.push({ from: s, to: s });
  });

  return {
    day: DAY_NAMES[dow],
    lessons: sorted.map(it => ({ from: fmt(it.start), to: fmt(it.end), minutes: it.end - it.start, name: it.name, source: it.source, frequency: it.frequency, note: it.note || '' })),
    freeGaps: gaps,
    fullHourStarts: ranges.map(r => r.from === r.to ? fmt(r.from) : fmt(r.from) + ' to ' + fmt(r.to))
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return fail(400, 'Invalid request body'); }

  const callerIp = getCallerIp(event);
  const lock = await isLockedOut(callerIp);
  if (lock.locked) return fail(429, 'Too many incorrect attempts. Please try again in about ' + lock.minutesLeft + ' minute(s).');
  if (!body.password || body.password !== process.env.ADMIN_PASSWORD) {
    await recordFailedAttempt(callerIp);
    return fail(401, 'Incorrect password.');
  }
  await clearFailedAttempts(callerIp);

  try {
    const todayStr = melbourneToday();
    const perDay = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    const warnings = [];

    // 1. regular students hard-coded in the booking system
    (RECURRING_STUDENTS || []).forEach(r => {
      if (!perDay[r.dow]) return;
      const start = timeToMinutes(r.time);
      perDay[r.dow].push({ start: start, end: start + r.duration, name: r.name, source: 'regular (hard-coded)', frequency: r.frequency || 'weekly' });
    });

    // 2. everyone enrolled online
    const online = [];
    const all = await listAllSubscriptions();
    (all || []).forEach(rec => {
      if (!rec || (rec.status !== 'active' && rec.status !== 'paused')) return;
      const dow = parseInt(rec.dayOfWeek, 10);
      if (isNaN(dow) || !rec.time) return;
      const dur = parseInt(rec.durationMinutes, 10) || 45;
      const entry = {
        name: rec.studentName || '(no name)',
        email: rec.studentEmail || '',
        day: DAY_NAMES[dow],
        time: rec.time,
        minutes: dur,
        frequency: rec.frequency || 'weekly',
        status: rec.status,
        pausedUntil: rec.pausedUntil || null,
        startDate: rec.startDate || null,
        nextLessonDate: rec.nextLessonDate || null
      };
      online.push(entry);
      if (rec.status !== 'active' || !perDay[dow]) return; // a paused enrollment frees its slot
      const start = timeToMinutes(rec.time);
      let note = '';
      if (rec.startDate && rec.startDate > todayStr) note = 'starts ' + rec.startDate;
      perDay[dow].push({ start: start, end: start + dur, name: rec.studentName || '(no name)', source: 'enrolled online', frequency: rec.frequency || 'weekly', note: note });
    });
    online.sort((a, b) => DAY_NAMES.indexOf(a.day) - DAY_NAMES.indexOf(b.day) || timeToMinutes(a.time) - timeToMinutes(b.time));

    // 3. warnings: overlaps and people counted twice
    Object.keys(perDay).forEach(d => {
      const items = perDay[d].slice().sort((a, b) => a.start - b.start);
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          if (items[i].start < items[j].end && items[j].start < items[i].end) {
            warnings.push(DAY_NAMES[d] + ': ' + items[i].name + ' (' + items[i].source + ', ' + fmt(items[i].start) + ') overlaps ' + items[j].name + ' (' + items[j].source + ', ' + fmt(items[j].start) + ').');
          }
        }
      }
    });
    (RECURRING_STUDENTS || []).forEach(r => {
      online.forEach(o => {
        if (o.status === 'active' && samePerson(r.name, o.name)) {
          warnings.push(r.name + ' is in the hard-coded roster (' + DAY_NAMES[r.dow] + ' ' + r.time + ') AND enrolled online as "' + o.name + '" (' + o.day + ' ' + o.time + '). If that is the same person, their slot is blocked twice.');
        }
      });
    });

    // 4. upcoming single lessons and packages booked online
    const bookings = store('bookings');
    const { blobs } = await bookings.list();
    const singles = [];
    const agendaBookings = [];
    for (const blob of blobs) {
      const dateStr = blob.key.split('_')[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || dateStr < todayStr) continue;
      const rec = await bookings.get(blob.key, { type: 'json' });
      if (rec && dateStr <= addDays(todayStr, 13)) agendaBookings.push(Object.assign({}, rec, { date: rec.date || dateStr }));
      if (!rec || rec.subscriptionId) continue;             // lessons of enrolled students are shown above
      if (rec.pendingPayment === true) continue;            // unpaid holds are not bookings
      singles.push({ date: rec.date || dateStr, time: rec.time, minutes: rec.duration || 45, name: rec.name || '', email: rec.email || '', type: rec.bookingType || '' });
    }
    singles.sort((a, b) => (a.date + ' ' + String(timeToMinutes(a.time)).padStart(4, '0')).localeCompare(b.date + ' ' + String(timeToMinutes(b.time)).padStart(4, '0')));

    // gift vouchers: lessons already paid for and not yet booked
    let vouchers = [];
    try {
      vouchers = (await listVouchers()).map(v => ({
        code: v.code, status: v.status || 'active', lessonsTotal: v.lessonsTotal, lessonsRemaining: lessonsRemaining(v),
        durationMinutes: v.durationMinutes, buyerName: v.buyerName || '', buyerEmail: v.buyerEmail || '', recipientName: v.recipientName || '',
        purchasedAt: v.purchasedAt, expiresAt: v.expiresAt,
        bookedLessons: (v.redemptions || []).reduce((all, r) => all.concat(r.dates || []), [])
      })).sort((a, b) => String(b.purchasedAt).localeCompare(String(a.purchasedAt)));
    } catch (e) {
      console.error('[admin-list-enrollments] could not list vouchers:', e && e.message ? e.message : e);
    }

    const week = [1, 2, 3, 4, 5].map(d => buildDay(d, perDay[d]));
    const agenda = buildAgenda(todayStr, agendaBookings, (all || []));
    return { statusCode: 200, body: JSON.stringify({ success: true, today: todayStr, agenda: agenda, week: week, onlineEnrollments: online, upcomingSingles: singles, vouchers: vouchers, warnings: warnings }) };
  } catch (err) {
    console.error('[admin-list-enrollments] error:', err && err.message ? err.message : err);
    return fail(500, 'Something went wrong loading the schedule.');
  }
};
