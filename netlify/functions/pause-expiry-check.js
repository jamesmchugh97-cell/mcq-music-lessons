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
const Stripe = require('stripe');
const {
  nextOccurrenceDate,
  listBlockingSubscriptionsForDay,
  conflictsWithSubscriptions,
  timeToMinutes,
  createLessonOccurrence,
  escapeHtml
} = require('./subscription-helpers');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

function subsStore() {
  return getStore({ name: 'subscriptions', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
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
  let blockedCount = 0;
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' });
    if (!record) continue;
    if (record.status === 'paused' && record.pausedUntil && record.pausedUntil <= today) {
      const resumedFrom = record.pausedUntil;

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

      // While paused, this slot is deliberately free for anyone else to
      // take (see listBlockingSubscriptionsForDay, which only counts
      // 'active' subscriptions) - that's the whole point of pausing
      // freeing it up. But that means by the time a pause ends, someone
      // else may have genuinely claimed the exact same day/time in the
      // meantime, either as a new subscriber or a one-off/rescheduled
      // booking. Resuming blindly into that would double-book the slot
      // and charge this student for a lesson time that's no longer
      // actually theirs. Checked here, before flipping back to active,
      // rather than left to be discovered as a scheduling conflict
      // later.
      let conflict = false;
      if (recomputedLessonDate) {
        const startMin = timeToMinutes(record.time);
        const endMin = startMin + parseInt(record.durationMinutes, 10);
        const otherSubs = await listBlockingSubscriptionsForDay(dow, record.subscriptionId);
        if (conflictsWithSubscriptions(otherSubs, startMin, endMin)) {
          conflict = true;
        }
        if (!conflict) {
          const bStore = bookingsStore();
          const existingBooking = await bStore.get(recomputedLessonDate + '_' + record.time, { type: 'json' });
          if (existingBooking) conflict = true;
        }
      }

      if (conflict) {
        // Doesn't try to resolve this automatically, since it genuinely
        // needs a human decision (a new time, a conversation between
        // James and the returning student, etc.) - just makes sure
        // nothing bad happens (no wrongful charge, no double-booking)
        // while that gets sorted out, and pushes the check out 2 weeks
        // rather than re-flagging this every single day.
        const extendedResume = new Date();
        extendedResume.setDate(extendedResume.getDate() + 14);
        const extendedResumeStr = extendedResume.toISOString().slice(0, 10);
        const extendedResumeEpoch = Math.floor(extendedResume.getTime() / 1000);
        try {
          await stripe.subscriptions.update(record.subscriptionId, {
            pause_collection: { behavior: 'void', resumes_at: extendedResumeEpoch }
          });
        } catch (e) {
          console.error('[pause-expiry-check] failed to extend Stripe pause for', record.subscriptionId, ':', e && e.message ? e.message : e);
        }
        record.pausedUntil = extendedResumeStr;
        await store.set(blob.key, JSON.stringify(record));
        blockedCount++;
        console.log('[pause-expiry-check] resume BLOCKED for ' + record.subscriptionId + ' (' + record.studentName + '), slot ' + dow + ' ' + record.time + ' no longer free, pause extended to ' + extendedResumeStr);

        if (record.studentEmail) {
          await sendEmail(
            record.studentEmail,
            'MCQ Music Lessons: your old time slot is no longer available',
            '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>Your pause has ended, but your usual time has since been taken by another student. No charge will happen while this gets sorted out, your subscription stays paused for now. James will be in touch to arrange a new time, or you\'re welcome to <a href="https://mcqmusiclessons.com.au/booking.html#calendar">subscribe to a different available time</a> yourself.</p><p>James</p>'
          );
        }
        await sendEmail(
          JAMES_EMAIL,
          'Action needed: ' + record.studentName + '\'s old slot is taken',
          '<p>' + escapeHtml(record.studentName) + '\'s (' + escapeHtml(record.studentEmail) + ') pause just ended, but their old slot (' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow] + ' ' + record.time + ') has since been taken by someone else. Their subscription stays paused, no charge, until this is sorted out, either manually here or by them subscribing to a new time themselves.</p>'
        );
        continue;
      }

      record.status = 'active';
      delete record.pausedUntil;
      if (recomputedLessonDate) {
        record.nextLessonDate = recomputedLessonDate;
      }

      await store.set(blob.key, JSON.stringify(record));
      resumedCount++;
      console.log('[pause-expiry-check] resumed subscription ' + record.subscriptionId + ' for ' + record.studentName + ', next lesson ' + record.nextLessonDate);

      // Creates this first post-resume lesson's booking record and
      // calendar event directly, right now - the next Stripe renewal
      // invoice would otherwise be the only thing that ever creates it,
      // but that renewal always advances one full interval from
      // whatever record.nextLessonDate already holds. Since it's set to
      // the correct resume date just above, waiting for that renewal
      // would skip straight past this lesson and create the calendar
      // event for the WRONG, later date instead - this lesson would
      // never appear on the calendar at all. Saved to the record first,
      // above, so the subscription is correctly active and unblocking
      // its slot regardless of whether this calendar step succeeds.
      if (recomputedLessonDate) {
        try {
          await createLessonOccurrence(recomputedLessonDate, record);
        } catch (occErr) {
          console.error('[pause-expiry-check] failed to create lesson occurrence for resumed subscription ' + record.subscriptionId + ':', occErr && occErr.message ? occErr.message : occErr);
        }
      }

      if (record.studentEmail) {
        await sendEmail(
          record.studentEmail,
          'MCQ Music Lessons: your subscription has resumed',
          '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>Your ' + record.frequency + ' subscription has resumed.' + (recomputedLessonDate ? ' Your next lesson is ' + formatFriendlyDate(recomputedLessonDate) + '.' : '') + ' Billing has resumed as normal.</p><p>You can pause again (if you still have weeks left this year) or cancel any time from your <a href="https://mcqmusiclessons.com.au/booking.html#manage-subscription">Manage Subscription</a> page.</p><p style="font-size:0.85em;color:#666;">Feeling unwell with cold or flu-like symptoms? Please reschedule rather than attending in person.</p><p>James</p>'
        );
      }
      await sendEmail(
        JAMES_EMAIL,
        'Subscription resumed: ' + record.studentName,
        '<p>' + escapeHtml(record.studentName) + '\'s subscription has automatically resumed' + (recomputedLessonDate ? ', next lesson ' + formatFriendlyDate(recomputedLessonDate) : '') + '.</p>'
      );
    }
  }
  console.log('[pause-expiry-check] checked ' + blobs.length + ' subscriptions, resumed ' + resumedCount + ', blocked (slot taken) ' + blockedCount);
  return { statusCode: 200, body: 'ok' };
}
// Runs daily. Netlify's scheduler interprets cron expressions in UTC, so
// '0 1 * * *' actually fires around 11am-12pm Melbourne time (AEST/AEDT
// depending on daylight saving), not literally 1am Melbourne as the
// expression might suggest at a glance - worth knowing if you're ever
// checking Netlify function logs and the timestamp looks "wrong".
exports.handler = schedule('0 1 * * *', run);
