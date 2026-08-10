// pause-expiry-check.js
// Netlify SCHEDULED function (runs once daily). Finds any paused
// subscription whose pause window has ended and flips it back to
// 'active' in the live subscriptions store, which automatically
// re-locks their slot against other bookings. Stripe itself already
// resumes billing on its own at the resumes_at timestamp set when the
// pause was created (see manage-subscription.js) - this function only
// keeps our own slot-blocking record in sync with that, so the slot
// doesn't stay marked as free past the pause window James/students
// agreed to.
const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');
const { nextOccurrenceDate } = require('./subscription-helpers');

const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

function subsStore() {
  return getStore({ name: 'subscriptions', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

async function sendEmail(to, subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>',
        to: [to],
        subject: subject,
        html: html
      })
    });
  } catch (e) {
    console.error('[pause-expiry-check] email send failed:', e && e.message ? e.message : e);
  }
}

// Formats a 'YYYY-MM-DD' date string into something readable in an
// email, e.g. 'Monday, 17 August 2026', instead of showing students the
// raw machine-format date.
function formatFriendlyDate(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function run() {
  const store = subsStore();
  const { blobs } = await store.list({ prefix: 'sub_' });
  const today = new Date().toISOString().slice(0, 10);
  let resumedCount = 0;
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' });
    if (!record) continue;
    if (record.status === 'paused' && record.pausedUntil && record.pausedUntil <= today) {
      const resumedFrom = record.pausedUntil;
      record.status = 'active';
      delete record.pausedUntil;

      // record.nextLessonDate is left completely untouched by the pause
      // action itself (confirmed - manage-subscription.js's pause
      // handler never writes it), so it's still whatever it was BEFORE
      // the pause started. If left as-is, stripe-webhook.js's renewal
      // branch would compute the next lesson as that stale pre-pause
      // date plus one billing interval, landing inside or before the
      // pause window instead of correctly after it. Recomputing it here
      // from the actual resume point fixes that.
      const dow = parseInt(record.dayOfWeek, 10);
      const recomputedLessonDate = nextOccurrenceDate(dow, record.time, 0, resumedFrom);
      if (recomputedLessonDate) {
        record.nextLessonDate = recomputedLessonDate;
      }

      await store.set(blob.key, JSON.stringify(record));
      resumedCount++;
      console.log('[pause-expiry-check] resumed subscription ' + record.subscriptionId + ' for ' + record.studentName + ', next lesson ' + record.nextLessonDate);

      if (record.studentEmail) {
        await sendEmail(
          record.studentEmail,
          'MCQ Music Lessons: your subscription has resumed',
          '<p>Hi ' + record.studentName + ',</p><p>Your ' + record.frequency + ' subscription has resumed.' + (recomputedLessonDate ? ' Your next lesson is ' + formatFriendlyDate(recomputedLessonDate) + '.' : '') + ' Billing has resumed as normal.</p><p>You can pause again (if you still have weeks left this year) or cancel any time from your <a href="https://mcqmusiclessons.com.au/booking.html#manage-subscription">Manage Subscription</a> page.</p><p>James</p>'
        );
      }
      await sendEmail(
        JAMES_EMAIL,
        'Subscription resumed: ' + record.studentName,
        '<p>' + record.studentName + '\'s subscription has automatically resumed' + (recomputedLessonDate ? ', next lesson ' + formatFriendlyDate(recomputedLessonDate) : '') + '.</p>'
      );
    }
  }
  console.log('[pause-expiry-check] checked ' + blobs.length + ' subscriptions, resumed ' + resumedCount);
  return { statusCode: 200, body: 'ok' };
}
// Runs daily. Netlify's scheduler interprets cron expressions in UTC, so
// '0 1 * * *' actually fires around 11am-12pm Melbourne time (AEST/AEDT
// depending on daylight saving), not literally 1am Melbourne as the
// expression might suggest at a glance - worth knowing if you're ever
// checking Netlify function logs and the timestamp looks "wrong".
exports.handler = schedule('0 1 * * *', run);
