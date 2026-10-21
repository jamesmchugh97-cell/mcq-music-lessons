// admin-free-lessons.js
// Netlify serverless function: lets James free up the time a student can no longer come to, when
// they have already paid for a package of lessons and a new time has not been found yet.
//   - preview: lists the upcoming paid lessons that would be taken off the calendar.
//   - free: removes those lessons from the booking list and Google Calendar (so the time is open
//     again), and makes a voucher for the same number of lessons so the student keeps what they
//     paid for. No email is sent; James gives the student the code when a new time is agreed.
// Protected by the admin password and lockout like the other admin tools.
const { getStore } = require('@netlify/blobs');
const { checkAdmin } = require('./admin-auth-helper');
const vh = require('./voucher-helpers');
const { deleteCalendarEvent } = require('./google-calendar-helper');

function fail(status, error) { return { statusCode: status, body: JSON.stringify({ success: false, error: error }) }; }
function clean(v, max) { return String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function todayMelbourne() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return fail(400, 'Invalid request body'); }
  const auth = await checkAdmin(event, body.password);
  if (!auth.ok) return fail(auth.status, auth.error);

  const needle = clean(body.student, 120).toLowerCase();
  if (needle.length < 3) return fail(400, 'Please enter the student\'s full name or email.');
  try {
    const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
    const { blobs } = await store.list();
    const today = todayMelbourne();
    const found = [];
    for (const b of blobs) {
      const r = await store.get(b.key, { type: 'json' });
      if (!r || !r.date || !r.time || r.pendingPayment === true) continue;
      if (r.bookingType !== 'package') continue;
      if (r.date < today) continue;
      if (String(r.name || '').toLowerCase() !== needle && String(r.email || '').toLowerCase() !== needle) continue;
      found.push({ key: b.key, record: r });
    }
    found.sort((a, b) => a.record.date.localeCompare(b.record.date));
    const lessons = found.map(f => ({ date: f.record.date, time: f.record.time, duration: f.record.duration || 45, name: f.record.name, email: f.record.email }));
    if (body.action !== 'free') return { statusCode: 200, body: JSON.stringify({ success: true, lessons: lessons }) };
    if (!found.length) return fail(404, 'No upcoming paid package lessons found for that name or email.');
    const names = new Set(found.map(f => String(f.record.name || '').toLowerCase() + '|' + String(f.record.email || '').toLowerCase()));
    if (names.size > 1) return fail(400, 'That matches more than one student. Please use their full email address.');
    const first = found[0].record;
    const duration = first.duration || 45;
    if (found.some(f => (f.record.duration || 45) !== duration)) return fail(400, 'Those lessons are different lengths, so a single voucher would not match. Nothing was changed.');

    // Make the voucher first, so if anything fails after this nothing is lost.
    let code = null;
    for (let i = 0; i < 6; i++) { const c = vh.generateCode(); if (!(await vh.getVoucher(c))) { code = c; break; } }
    if (!code) return fail(500, 'Could not make a code. Nothing was changed. Please try again.');
    const nowMs = Date.now();
    const voucher = {
      code: code, status: 'active', lessonsTotal: found.length, durationMinutes: duration, pricePaidCents: 0,
      buyerName: first.name || '', buyerEmail: String(first.email || '').toLowerCase(), recipientName: first.name || '', message: '',
      purchasedAt: new Date(nowMs).toISOString(), expiresAt: vh.expiryDateFrom(nowMs), paymentIntentId: null,
      sessionId: 'freed-' + code, createdBy: 'admin', note: 'Replaces ' + found.length + ' paid package lessons taken off the calendar by admin', redemptions: []
    };
    await vh.saveVoucher(voucher);
    let calendarFailed = 0;
    for (const f of found) {
      if (f.record.eventId) { try { await deleteCalendarEvent(f.record.eventId); } catch (e) { calendarFailed++; } }
      await store.delete(f.key);
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, lessons: lessons, code: code, lessonsLeft: found.length, durationMinutes: duration, calendarFailed: calendarFailed }) };
  } catch (e) {
    console.error('[admin-free-lessons] error:', e && e.message ? e.message : e);
    return fail(500, 'Something went wrong. Please check "Who\'s booked in" before trying again.');
  }
};
