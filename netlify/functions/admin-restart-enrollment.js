// admin-restart-enrollment.js
// Netlify serverless function: lets James move an enrolled student's start
// date (e.g. "I signed up but I actually want to start on 16 November")
// from the password-gated admin page, without touching code or editing
// Stripe and the calendar by hand.
//
// What "apply" does, in this order:
//   1. Stripe: clears any pause and moves the next charge to the chosen
//      date (a trial end on the existing subscription, with no proration
//      and no refund or extra charge). Done FIRST, so if Stripe says no,
//      nothing else has been touched.
//   2. Removes this student's old upcoming lessons from the bookings store
//      and deletes their Google Calendar events.
//   3. Updates their enrollment record: active again (no longer paused),
//      first lesson on the new date.
//   4. Creates the new first lesson (booking record + calendar event).
//   5. Voids any unused reschedule credit for them, since the payment that
//      covered the cancelled lesson now covers the new first lesson.
//   6. Emails the student and James.
//
// Their first lesson is treated as already paid for (that is the whole
// point of this tool: the money is already in). The next charge defaults
// to 3 days before their SECOND lesson at 9am Melbourne, the same rhythm
// as every other new enrollment (see create-subscription.js), and then
// carries on every week or fortnight as usual - each payment books the
// next lesson, exactly like normal (see stripe-webhook.js).
//
// "preview" returns exactly what "apply" would do and changes nothing.
//
// Password-protected with the same ADMIN_PASSWORD and lockout as
// admin-closure.js, since this can move a student's billing.
const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');
const {
  listSubscriptionsByEmail,
  saveSubscriptionRecord,
  listBlockingSubscriptionsForDay,
  conflictsWithSubscriptions,
  createLessonOccurrence,
  timeToMinutes,
  melbourneEpochMs,
  isStalePendingHold,
  escapeHtml
} = require('./subscription-helpers');
const { deleteCalendarEvent } = require('./google-calendar-helper');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';
const CHARGE_DAYS_BEFORE = 3;
const MAX_START_AHEAD_DAYS = 200;

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

async function sendEmail(to, subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>', to: [to], subject: subject, html: html })
    });
  } catch (e) {
    console.error('[admin-restart-enrollment] email send failed:', e && e.message ? e.message : e);
  }
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nice(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fail(status, message) {
  return { statusCode: status, body: JSON.stringify({ success: false, error: message }) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return fail(400, 'Invalid request body'); }
  const { action, password, email, newStartDate, chargeFrom, subscriptionId } = body;

  const callerIp = getCallerIp(event);
  const lock = await isLockedOut(callerIp);
  if (lock.locked) return fail(429, 'Too many incorrect attempts. Please try again in about ' + lock.minutesLeft + ' minute(s).');
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    await recordFailedAttempt(callerIp);
    return fail(401, 'Incorrect password.');
  }
  await clearFailedAttempts(callerIp);

  if (action !== 'preview' && action !== 'apply') return fail(400, 'Unknown action.');
  if (!email || !/^\d{4}-\d{2}-\d{2}$/.test(newStartDate || '')) return fail(400, 'Please give the student\'s email and the new first lesson date.');

  try {
    // ---- find the enrollment
    let subs = (await listSubscriptionsByEmail(email)).filter(r => r.status === 'active' || r.status === 'paused');
    if (subscriptionId) subs = subs.filter(r => r.subscriptionId === subscriptionId);
    if (subs.length === 0) return fail(404, 'No active or paused enrollment found for that email.');
    if (subs.length > 1) {
      return fail(409, 'That email has ' + subs.length + ' enrollments: ' + subs.map(r => r.subscriptionId + ' (' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][parseInt(r.dayOfWeek, 10)] + ' ' + r.time + ')').join('; ') + '. Add the subscriptionId to choose one.');
    }
    const record = subs[0];
    const dow = parseInt(record.dayOfWeek, 10);
    const interval = record.frequency === 'fortnightly' ? 14 : 7;

    // ---- validate the new date
    const todayStr = new Date().toISOString().slice(0, 10);
    const d = new Date(newStartDate + 'T00:00:00');
    if (isNaN(d.getTime()) || d.getDay() !== dow) {
      return fail(400, nice(newStartDate) + ' is not a ' + ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow] + ', which is this student\'s lesson day.');
    }
    if (newStartDate <= todayStr) return fail(400, 'The new first lesson must be after today.');
    if (newStartDate > addDays(todayStr, MAX_START_AHEAD_DAYS)) return fail(400, 'That date is too far ahead.');

    // ---- the slot must be free on the new date and from then on
    const startMin = timeToMinutes(record.time);
    const endMin = startMin + parseInt(record.durationMinutes, 10);
    const otherSubs = await listBlockingSubscriptionsForDay(dow, record.subscriptionId);
    if (conflictsWithSubscriptions(otherSubs, startMin, endMin)) {
      return fail(409, 'Another enrolled student already has that day and time, so this student can\'t restart there.');
    }

    const bookings = store('bookings');
    const { blobs } = await bookings.list();
    const toRemove = [];
    const clashes = [];
    for (const blob of blobs) {
      const dateStr = blob.key.split('_')[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || dateStr < todayStr) continue;
      const rec = await bookings.get(blob.key, { type: 'json' });
      if (!rec) continue;
      if (rec.subscriptionId === record.subscriptionId) {
        if (blob.key !== newStartDate + '_' + record.time) toRemove.push({ key: blob.key, date: dateStr, time: rec.time, eventId: rec.eventId || null });
        continue;
      }
      // someone else's lesson in this student's weekly slot, from the new start onwards
      if (dateStr >= newStartDate && new Date(dateStr + 'T00:00:00').getDay() === dow && rec.time && !isStalePendingHold(rec)) {
        const s = timeToMinutes(rec.time);
        const e = s + (rec.duration || 45);
        if (startMin < e && s < endMin) clashes.push(dateStr + ' ' + rec.time);
      }
    }
    if (clashes.length > 0) {
      return fail(409, 'Someone else already has a lesson in that slot on: ' + clashes.sort().join(', ') + '. Move or cancel those first, or choose a later start.');
    }

    // ---- when they are charged next
    const secondLesson = addDays(newStartDate, interval);
    const nextChargeDate = (chargeFrom && /^\d{4}-\d{2}-\d{2}$/.test(chargeFrom)) ? chargeFrom : addDays(secondLesson, -CHARGE_DAYS_BEFORE);
    const trialEnd = Math.floor(melbourneEpochMs(nextChargeDate, '9:00 am') / 1000);
    if (trialEnd - Math.floor(Date.now() / 1000) < 3 * 86400) return fail(400, 'The next charge date must be at least 3 days from now.');

    // ---- the Stripe side
    let stripeSub;
    try {
      stripeSub = await stripe.subscriptions.retrieve(record.subscriptionId);
    } catch (e) {
      return fail(502, 'Could not look up this enrollment in Stripe: ' + (e && e.message ? e.message : e));
    }
    if (!stripeSub || !['active', 'trialing'].includes(stripeSub.status)) {
      return fail(409, 'This enrollment is "' + (stripeSub && stripeSub.status) + '" in Stripe (not active), so it needs sorting out in Stripe first.');
    }

    // ---- unused reschedule credits that came from the cancelled lesson
    const creditStore = store('reschedule-credits');
    const creditKeys = [];
    try {
      const { blobs: cb } = await creditStore.list();
      for (const b of cb) {
        const c = await creditStore.get(b.key, { type: 'json' });
        if (c && !c.used && (c.email || '').trim().toLowerCase() === email.trim().toLowerCase() && (!c.weekEnd || c.weekEnd >= todayStr)) creditKeys.push(b.key);
      }
    } catch (e) {}

    const plan = {
      student: record.studentName,
      email: record.studentEmail,
      subscriptionId: record.subscriptionId,
      lessonSlot: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow] + ' ' + record.time + ', ' + record.durationMinutes + ' min, ' + record.frequency,
      currentStatus: record.status + (record.pausedUntil ? ' until ' + record.pausedUntil : ''),
      currentNextLesson: record.nextLessonDate || null,
      newFirstLesson: newStartDate,
      secondLesson: secondLesson,
      lessonsToRemoveFromCalendar: toRemove.map(r => r.date + ' ' + r.time),
      unusedRescheduleCreditsToVoid: creditKeys.length,
      stripe: { clearPause: !!stripeSub.pause_collection, nextChargeDate: nextChargeDate, nextChargeAt: '9:00 am Melbourne', firstLessonIsAlreadyPaid: true }
    };

    if (action === 'preview') return { statusCode: 200, body: JSON.stringify({ success: true, preview: true, plan: plan }) };

    // ================= APPLY =================
    // 1. Stripe first: if it refuses, nothing else has changed.
    try {
      await stripe.subscriptions.update(record.subscriptionId, {
        pause_collection: '',
        trial_end: trialEnd,
        proration_behavior: 'none'
      });
    } catch (e) {
      return fail(502, 'Stripe would not update this enrollment, so nothing was changed: ' + (e && e.message ? e.message : e));
    }

    const warnings = [];
    // 2. old lessons off the books and the calendar
    for (const r of toRemove) {
      try {
        await bookings.delete(r.key);
        if (r.eventId) {
          try { await deleteCalendarEvent(r.eventId); } catch (e) { warnings.push('Could not delete the calendar event for ' + r.date + ' - delete it by hand.'); }
        }
      } catch (e) {
        warnings.push('Could not remove the booking for ' + r.date + '.');
      }
    }

    // 3. the enrollment record
    record.status = 'active';
    delete record.pausedUntil;
    delete record.firstPaymentPending;
    record.nextLessonDate = newStartDate;
    record.startDate = newStartDate;
    await saveSubscriptionRecord(record.subscriptionId, record);

    // 4. the new first lesson
    let created = null;
    try {
      // Running this twice for the same student and date is harmless: if
      // their new first lesson already exists, it is simply kept.
      const already = await bookings.get(newStartDate + '_' + record.time, { type: 'json' });
      if (already && already.subscriptionId === record.subscriptionId) created = true;
      else created = await createLessonOccurrence(newStartDate, record);
    } catch (e) {}
    if (!created) warnings.push('The first lesson on ' + newStartDate + ' could not be added to the calendar automatically - add it by hand.');

    // 5. credits
    for (const k of creditKeys) {
      try {
        const c = await creditStore.get(k, { type: 'json' });
        if (c) { c.used = true; c.voidedBy = 'enrollment-restart'; await creditStore.set(k, JSON.stringify(c)); }
      } catch (e) {}
    }

    // 6. emails
    if (record.studentEmail) {
      await sendEmail(
        record.studentEmail,
        'MCQ Music Lessons: your first lesson is ' + nice(newStartDate),
        '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>Your ' + escapeHtml(record.frequency) + ' enrollment is now set to start on <strong>' + escapeHtml(nice(newStartDate)) + ' at ' + escapeHtml(record.time) + '</strong>. Your first lesson is already paid for, and you will not be charged again until ' + escapeHtml(nice(nextChargeDate)) + ' (a few days before your second lesson). After that, you are charged a few days before each lesson.</p><p>Lessons are at 84 Nelson Rd, South Melbourne VIC 3205.</p><p>See you then!<br>James</p>'
      );
    }
    await sendEmail(
      JAMES_EMAIL,
      'Enrollment moved: ' + record.studentName + ' now starts ' + newStartDate,
      '<p>' + escapeHtml(record.studentName) + ' (' + escapeHtml(record.studentEmail) + ') now starts on <strong>' + escapeHtml(nice(newStartDate)) + '</strong>. Removed ' + toRemove.length + ' old lesson(s) from the calendar, voided ' + creditKeys.length + ' reschedule credit(s). Next charge: ' + escapeHtml(nice(nextChargeDate)) + ' at 9am.' + (warnings.length ? '</p><p><strong>Needs a manual check:</strong> ' + escapeHtml(warnings.join(' ')) : '') + '</p>'
    );

    return { statusCode: 200, body: JSON.stringify({ success: true, applied: true, plan: plan, warnings: warnings }) };
  } catch (err) {
    console.error('[admin-restart-enrollment] error:', err && err.message ? err.message : err);
    return fail(500, 'Something went wrong, nothing further was changed: ' + (err && err.message ? err.message : err));
  }
};
