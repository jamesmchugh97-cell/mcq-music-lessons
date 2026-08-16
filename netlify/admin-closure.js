// admin-closure.js
// Netlify serverless function: lets James set or clear a studio closure
// window (e.g. his own Christmas break) from a simple password-gated
// admin page, without touching code or waiting on a deploy. Every
// currently-active subscriber gets notified immediately when a closure
// is set, well before it actually starts. The actual Stripe billing
// pause itself can't be scheduled for a future date (see
// summer-closure-start-check.js's own notes on this), so 'set' here
// only records the window and sends advance notice - the real pause is
// applied by that daily job once the start date arrives.
//
// Password-protected because this is powerful enough to stop billing
// for the entire business at once if triggered by the wrong person -
// checked against the ADMIN_PASSWORD environment variable, nothing
// fancier than that, no session or login system, matching how
// lightweight everything else on this site already is.
const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');
const {
  listAllSubscriptions,
  saveSubscriptionRecord,
  getClosureSettings,
  saveClosureSettings,
  deleteClosureSettings,
  nextOccurrenceDate,
  escapeHtml
} = require('./subscription-helpers');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

// Basic brute-force protection: this endpoint can stop billing for the
// entire business if guessed correctly, so repeated wrong guesses get
// locked out rather than allowed to keep trying indefinitely. Tracked
// per source IP in a small dedicated store, not tied to any one
// closure record, so it persists across separate set/clear attempts.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;
const ATTEMPT_WINDOW_MINUTES = 15;

function authAttemptsStore() {
  return getStore({ name: 'admin-auth-attempts', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

function getCallerIp(event) {
  const headers = event.headers || {};
  return headers['x-nf-client-connection-ip'] || headers['client-ip'] || (headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

async function isLockedOut(ip) {
  const store = authAttemptsStore();
  const record = await store.get('ip_' + ip, { type: 'json' });
  const now = Date.now();
  if (record && record.lockedUntil && record.lockedUntil > now) {
    return { locked: true, minutesLeft: Math.ceil((record.lockedUntil - now) / 60000) };
  }
  return { locked: false };
}

async function recordFailedAttempt(ip) {
  const store = authAttemptsStore();
  const key = 'ip_' + ip;
  const now = Date.now();
  let record = await store.get(key, { type: 'json' });
  // Resets the count if the previous window has already fully elapsed,
  // so this only ever locks out a genuine burst of wrong guesses, not
  // a slow trickle of them over days.
  if (!record || !record.windowStart || (now - record.windowStart) > ATTEMPT_WINDOW_MINUTES * 60 * 1000) {
    record = { windowStart: now, failedCount: 0 };
  }
  record.failedCount = (record.failedCount || 0) + 1;
  if (record.failedCount >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MINUTES * 60 * 1000;
  }
  await store.set(key, JSON.stringify(record));
}

async function clearFailedAttempts(ip) {
  const store = authAttemptsStore();
  try {
    await store.delete('ip_' + ip);
  } catch (e) {
    // Nothing to clear, fine.
  }
}

async function sendEmail(to, subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>', to: [to], subject: subject, html: html })
    });
  } catch (e) {
    console.error('[admin-closure] email send failed:', e && e.message ? e.message : e);
  }
}

function formatFriendlyDate(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body' }) };
  }
  const { action, password } = body;

  if (action === 'get') {
    const closure = await getClosureSettings();
    return { statusCode: 200, body: JSON.stringify({ success: true, closure: closure || null }) };
  }

  // Every other action changes something, so the password is required
  // from here on.
  const callerIp = getCallerIp(event);
  const lockStatus = await isLockedOut(callerIp);
  if (lockStatus.locked) {
    return { statusCode: 429, body: JSON.stringify({ success: false, error: 'Too many incorrect attempts. Please try again in about ' + lockStatus.minutesLeft + ' minute(s).' }) };
  }
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    await recordFailedAttempt(callerIp);
    return { statusCode: 401, body: JSON.stringify({ success: false, error: 'Incorrect password.' }) };
  }
  await clearFailedAttempts(callerIp);

  if (action === 'set') {
    const { startDate, endDate } = body;
    if (!startDate || !endDate || endDate <= startDate) {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Please provide a valid start and end date, with the end after the start.' }) };
    }
    const existing = await getClosureSettings();
    if (existing) {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: 'A closure is already set. Clear it first if you want to change the dates.' }) };
    }

    await saveClosureSettings({ startDate: startDate, endDate: endDate, applied: false, setAt: new Date().toISOString() });

    const allSubs = await listAllSubscriptions();
    const activeSubs = allSubs.filter(s => s.status === 'active');
    let notified = 0;
    for (const s of activeSubs) {
      if (s.studentEmail) {
        await sendEmail(
          s.studentEmail,
          'MCQ Music Lessons: closed ' + formatFriendlyDate(startDate) + ' - ' + formatFriendlyDate(endDate),
          '<p>Hi ' + escapeHtml(s.studentName) + ',</p><p>Just a heads up, MCQ Music will be closed from ' + formatFriendlyDate(startDate) + ' to ' + formatFriendlyDate(endDate) + '. Your subscription will automatically pause for that period, no charge, and pick back up right after with no need to do anything yourself.</p><p>James</p>'
        );
        notified++;
      }
    }
    await sendEmail(
      JAMES_EMAIL,
      'Closure set: ' + formatFriendlyDate(startDate) + ' - ' + formatFriendlyDate(endDate),
      '<p>Closure recorded for ' + formatFriendlyDate(startDate) + ' to ' + formatFriendlyDate(endDate) + '. ' + notified + ' active subscriber(s) notified. Their billing will actually pause once ' + startDate + ' arrives (handled automatically), and resume automatically after ' + endDate + '.</p>'
    );

    return { statusCode: 200, body: JSON.stringify({ success: true, notified: notified }) };
  }

  if (action === 'clear') {
    const closure = await getClosureSettings();
    if (!closure) {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: 'No closure is currently set.' }) };
    }

    // If it was already applied (i.e. today is on or after the start
    // date, so subscriptions are actually paused because of it right
    // now), resume them immediately rather than waiting for the
    // originally scheduled end date. This is the one case where Stripe
    // needs an explicit call, since its own resumes_at is still set to
    // the closure's original end date and won't fire early on its own.
    let resumed = 0;
    if (closure.applied) {
      const allSubs = await listAllSubscriptions();
      for (const record of allSubs) {
        if (record.status === 'paused' && record.pausedReason === 'studio_closure') {
          await stripe.subscriptions.update(record.subscriptionId, { pause_collection: '' });
          const resumedFrom = record.pausedUntil;
          record.status = 'active';
          delete record.pausedUntil;
          delete record.pausedReason;
          const dow = parseInt(record.dayOfWeek, 10);
          const recomputedLessonDate = nextOccurrenceDate(dow, record.time, 0, resumedFrom);
          if (recomputedLessonDate) record.nextLessonDate = recomputedLessonDate;
          await saveSubscriptionRecord(record.subscriptionId, record);
          if (record.studentEmail) {
            await sendEmail(
              record.studentEmail,
              'MCQ Music Lessons: the closure has been lifted',
              '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>Good news, the closure has ended early and your subscription has resumed' + (recomputedLessonDate ? ', next lesson ' + formatFriendlyDate(recomputedLessonDate) : '') + '. Billing has resumed as normal.</p><p>James</p>'
            );
          }
          resumed++;
        }
      }
    }

    await deleteClosureSettings();
    return { statusCode: 200, body: JSON.stringify({ success: true, resumed: resumed }) };
  }

  return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Unknown action.' }) };
};
