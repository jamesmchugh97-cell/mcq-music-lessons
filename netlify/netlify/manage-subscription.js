// manage-subscription.js
// Netlify serverless function: fully self-service subscription
// management for students, look up their own subscription(s) by
// email, pause (within the 4-weeks-a-year cap), or cancel. No manual
// involvement from James at any point; every action here is something
// the student triggers themselves.
const Stripe = require('stripe');
const {
  getSubscriptionRecord,
  saveSubscriptionRecord,
  canPauseWeeks,
  totalPausedWeeksForEmail,
  acquireEmailPauseLock,
  releaseEmailPauseLock,
  MAX_PAUSE_WEEKS_PER_YEAR,
  pausedWeeksThisYear,
  currentYear,
  getEmailHistory,
  emailPausedWeeksThisYear,
  emailSummerWeeksUsedThisYear,
  saveEmailHistory,
  summerWeeksUsed,
  canUseSummerWeeks,
  totalSummerWeeksForEmail,
  listSubscriptionsByEmail,
  SUMMER_PAUSE_START,
  SUMMER_PAUSE_END,
  MAX_SUMMER_PAUSE_WEEKS,
  clearImminentLessonIfWithinPause,
  PRICE_IDS,
  escapeHtml
} = require('./subscription-helpers');
const { getStore } = require('@netlify/blobs');

const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

async function sendEmail(to, subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>', to: [to], subject: subject, html: html })
    });
  } catch (e) {
    console.error('[manage-subscription] email send failed:', e && e.message ? e.message : e);
  }
}

function formatFriendlyDate(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function subsStore() {
  return getStore({ name: 'subscriptions', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
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

  const { action, email } = body;
  if (!action || !email) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing action or email.' }) };
  }

  try {
    if (action === 'lookup') {
      const subs = await listSubscriptionsByEmail(email);
      // The pause pool is shared across every subscription under this
      // email (see totalPausedWeeksForEmail), so "weeks remaining" is
      // the same figure for every one of them - computed once here from
      // the same subs list already fetched above, plus the email's
      // history for any since-cancelled subscriptions, rather than
      // recomputed per subscription as if each had its own independent
      // pool. Showing a per-subscription figure that ignored the others
      // would tell a student they have weeks available that pausing
      // would then immediately reject.
      const history = await getEmailHistory(email);
      const totalPausedAcrossAll = emailPausedWeeksThisYear(history) + subs.reduce((sum, s) => sum + pausedWeeksThisYear(s), 0);
      const totalSummerAcrossAll = emailSummerWeeksUsedThisYear(history) + subs.reduce((sum, s) => sum + summerWeeksUsed(s), 0);
      // One merged pool now, not two separate budgets - "remaining" is
      // the same shared figure either way, computed from BOTH kinds of
      // usage combined against the one shared cap.
      const sharedWeeksRemaining = Math.max(0, MAX_PAUSE_WEEKS_PER_YEAR - totalPausedAcrossAll - totalSummerAcrossAll);
      const sharedPauseWeeksRemaining = sharedWeeksRemaining;
      const sharedSummerWeeksRemaining = sharedWeeksRemaining;
      const summarized = subs.map(s => ({
        subscriptionId: s.subscriptionId,
        instrument: s.instrument,
        dayOfWeek: DAY_NAMES[parseInt(s.dayOfWeek, 10)],
        time: s.time,
        durationMinutes: s.durationMinutes,
        frequency: s.frequency,
        status: s.status,
        pausedUntil: s.pausedUntil || null,
        pausedWeeksUsedThisYear: pausedWeeksThisYear(s),
        pauseWeeksRemaining: sharedPauseWeeksRemaining,
        nextLessonDate: s.nextLessonDate || null,
        cancelling: !!s.cancelling,
        summerPausePending: !!s.summerPausePending,
        summerPauseEndDate: s.summerPauseEndDate || null,
        summerWeeksRemaining: sharedSummerWeeksRemaining
      }));
      return { statusCode: 200, body: JSON.stringify({ success: true, subscriptions: summarized, summerPauseStart: SUMMER_PAUSE_START, summerPauseEnd: SUMMER_PAUSE_END }) };
    }

    // Every action below acts on one specific subscription, and the
    // email in the request must match the record on file, this is the
    // only "auth" check, same lightweight email-match approach already
    // used by Manage Booking elsewhere on the site.
    const { subscriptionId } = body;
    if (!subscriptionId) {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing subscriptionId.' }) };
    }
    const record = await getSubscriptionRecord(subscriptionId);
    if (!record || (record.studentEmail || '').trim().toLowerCase() !== email.trim().toLowerCase()) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Subscription not found for that email.' }) };
    }

    if (action === 'pause') {
      const weeks = parseInt(body.weeks, 10);
      if (!weeks || weeks < 1 || weeks > MAX_PAUSE_WEEKS_PER_YEAR) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please choose between 1 and ' + MAX_PAUSE_WEEKS_PER_YEAR + ' weeks.' }) };
      }
      if (record.status === 'paused') {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'This subscription is already paused.' }) };
      }
      // Acquired right before the cross-subscription read, held only
      // through the write just below - not through the slower Stripe
      // and email calls that follow, since those aren't part of the
      // actual race window and holding the lock through them would
      // just make a genuinely sequential second request wait longer
      // than necessary.
      const lockAcquired = await acquireEmailPauseLock(record.studentEmail);
      if (!lockAcquired) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please wait a moment and try again - another pause request for this email is still being processed.' }) };
      }
      let otherWeeksUsed;
      try {
        // Weeks already used on any OTHER subscription under this same
        // email this year - whether still active/paused right now, or
        // since cancelled - count against this same shared allowance too.
        // Two different students, each with their own email, are
        // correctly unaffected by each other here.
        otherWeeksUsed = await totalPausedWeeksForEmail(record.studentEmail, subscriptionId);
        if (!canPauseWeeks(record, weeks, otherWeeksUsed)) {
          const remaining = Math.max(0, MAX_PAUSE_WEEKS_PER_YEAR - pausedWeeksThisYear(record) - summerWeeksUsed(record) - otherWeeksUsed);
          return { statusCode: 200, body: JSON.stringify({ success: false, error: 'You only have ' + remaining + ' pause week(s) left this year.' }) };
        }

        const resumeDateCheck = new Date();
        resumeDateCheck.setDate(resumeDateCheck.getDate() + weeks * 7);

        await stripe.subscriptions.update(subscriptionId, {
          pause_collection: { behavior: 'void', resumes_at: Math.floor(resumeDateCheck.getTime() / 1000) }
        });

        const usedBefore = pausedWeeksThisYear(record);
        record.status = 'paused';
        record.pausedUntil = resumeDateCheck.toISOString().slice(0, 10);
        record.pausedWeeksThisYear = usedBefore + weeks;
        record.pauseYear = currentYear();
        // Pausing is a deliberate choice to stop billing, which makes any
        // in-progress payment-failure grace period moot. Clearing it here
        // stops a resume from accidentally inheriting a stale, unrelated
        // failure timestamp from before the pause and getting cancelled
        // by subscription-payment-grace-check.js almost immediately after.
        record.paymentFailedAt = null;
        record.paymentFailureReminderSent = false;
        await saveSubscriptionRecord(subscriptionId, record);
      } finally {
        await releaseEmailPauseLock(record.studentEmail);
      }

      // Also persisted at the email level (not just on this one
      // subscription record) so this usage survives even if this
      // subscription is later cancelled and a new one started - see
      // inheritedPauseWeeksForNewSubscription in subscription-helpers.js.
      try {
        const existingHistory = await getEmailHistory(email);
        const emailWeeksSoFar = existingHistory && existingHistory.pauseYear === currentYear() ? (existingHistory.pausedWeeksThisYear || 0) : 0;
        await saveEmailHistory(email, {
          pausedWeeksThisYear: Math.max(emailWeeksSoFar, record.pausedWeeksThisYear),
          pauseYear: currentYear(),
          lastEndedAt: existingHistory ? existingHistory.lastEndedAt : undefined
        });
      } catch (historyErr) {
        console.error('[manage-subscription] failed to sync email history on pause:', historyErr && historyErr.message ? historyErr.message : historyErr);
      }

      let clearedLessonDate = null;
      try {
        clearedLessonDate = await clearImminentLessonIfWithinPause(record, record.pausedUntil);
      } catch (clearErr) {
        console.error('[manage-subscription] failed to clear imminent lesson on pause:', clearErr && clearErr.message ? clearErr.message : clearErr);
      }

      if (record.studentEmail) {
        await sendEmail(
          record.studentEmail,
          'MCQ Music Lessons: your subscription is paused',
          '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>Your subscription is paused' + (clearedLessonDate ? ', including your lesson on ' + formatFriendlyDate(clearedLessonDate) : '') + '. No charge while paused. It resumes automatically on ' + formatFriendlyDate(record.pausedUntil) + ', nothing further to do.</p><p>James</p>'
        );
      }
      await sendEmail(
        JAMES_EMAIL,
        'Subscription paused: ' + record.studentName,
        '<p>' + escapeHtml(record.studentName) + ' (' + escapeHtml(record.studentEmail) + ') has paused for ' + weeks + ' week(s), resuming ' + formatFriendlyDate(record.pausedUntil) + '.' + (clearedLessonDate ? ' Their lesson on ' + formatFriendlyDate(clearedLessonDate) + ' has been cleared from the calendar as part of this.' : '') + '</p>'
      );

      return { statusCode: 200, body: JSON.stringify({ success: true, pausedUntil: record.pausedUntil, pauseWeeksRemaining: Math.max(0, MAX_PAUSE_WEEKS_PER_YEAR - record.pausedWeeksThisYear - summerWeeksUsed(record) - otherWeeksUsed) }) };
    }

    if (action === 'pauseSummer') {
      const weeks = parseInt(body.weeks, 10);
      if (!weeks || weeks < 1 || weeks > MAX_PAUSE_WEEKS_PER_YEAR) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please choose between 1 and ' + MAX_PAUSE_WEEKS_PER_YEAR + ' weeks.' }) };
      }
      if (record.status === 'paused' || record.summerPausePending) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'This subscription already has a pause in place.' }) };
      }
      const lockAcquiredSummer = await acquireEmailPauseLock(record.studentEmail);
      if (!lockAcquiredSummer) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please wait a moment and try again - another pause request for this email is still being processed.' }) };
      }
      let otherSummerWeeksUsed;
      try {
        otherSummerWeeksUsed = await totalSummerWeeksForEmail(record.studentEmail, subscriptionId);
        if (!canUseSummerWeeks(record, weeks, otherSummerWeeksUsed)) {
          const remaining = Math.max(0, MAX_PAUSE_WEEKS_PER_YEAR - pausedWeeksThisYear(record) - summerWeeksUsed(record) - otherSummerWeeksUsed);
          return { statusCode: 200, body: JSON.stringify({ success: false, error: 'You only have ' + remaining + ' summer week(s) left for this break.' }) };
        }

        // Stripe's pause_collection takes effect the moment it's called,
        // there's no way to schedule it for a future start date. So this
        // just records the request now (which can happen any time in
        // advance) and a daily check (summer-closure-start-check.js)
        // actually applies the Stripe pause once SUMMER_PAUSE_START
        // arrives, exactly like a subscription that's still 'active' in
        // every other respect right up until then.
        const proposedEndCheck = new Date(SUMMER_PAUSE_START + 'T00:00:00');
        proposedEndCheck.setDate(proposedEndCheck.getDate() + weeks * 7);
        const windowEndCheck = new Date(SUMMER_PAUSE_END + 'T00:00:00');
        const summerPauseEndDateCheck = (proposedEndCheck < windowEndCheck ? proposedEndCheck : windowEndCheck).toISOString().slice(0, 10);

        record.summerPausePending = true;
        record.summerPauseEndDate = summerPauseEndDateCheck;
        record.summerWeeksUsed = summerWeeksUsed(record) + weeks;
        record.summerPauseYear = currentYear();
        await saveSubscriptionRecord(subscriptionId, record);
      } finally {
        await releaseEmailPauseLock(record.studentEmail);
      }

      if (record.studentEmail) {
        await sendEmail(
          record.studentEmail,
          'MCQ Music Lessons: your summer break is booked in',
          '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>Your summer break is booked in. Billing and lessons will pause from ' + formatFriendlyDate(SUMMER_PAUSE_START) + ' and pick back up automatically on ' + formatFriendlyDate(record.summerPauseEndDate) + '. Nothing else to do, no charge while paused.</p><p>James</p>'
        );
      }

      return { statusCode: 200, body: JSON.stringify({ success: true, summerPauseEndDate: record.summerPauseEndDate, summerWeeksRemaining: Math.max(0, MAX_PAUSE_WEEKS_PER_YEAR - pausedWeeksThisYear(record) - summerWeeksUsed(record)) }) };
    }

    if (action === 'changeFrequency') {
      const newFrequency = body.newFrequency;
      if (newFrequency !== 'weekly' && newFrequency !== 'fortnightly') {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Frequency must be weekly or fortnightly.' }) };
      }
      if (newFrequency === record.frequency) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That is already your current frequency.' }) };
      }
      if (record.status !== 'active') {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Only an active subscription can change frequency. Please wait until any pause has ended.' }) };
      }
      const priceId = PRICE_IDS[String(record.durationMinutes) + '_' + newFrequency];
      if (!priceId) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Could not find a matching price for that duration and frequency.' }) };
      }

      // Swaps the price on the EXISTING subscription (rather than
      // cancelling and creating a new one), so there's no gap in
      // coverage and no need to go through Checkout again. Takes effect
      // from the next renewal onward: their already-scheduled next
      // lesson (record.nextLessonDate) stays exactly as it is, and
      // nextRenewalDate() in stripe-webhook.js will pick up the new
      // frequency automatically the next time it computes an interval
      // from record.frequency, since that's read fresh each time. No
      // proration, matching the "no fussy adjustments" approach used
      // everywhere else on this site.
      const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
      const itemId = stripeSub.items.data[0].id;
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: 'none'
      });

      const oldFrequency = record.frequency;
      record.frequency = newFrequency;
      await saveSubscriptionRecord(subscriptionId, record);

      if (record.studentEmail) {
        await sendEmail(
          record.studentEmail,
          'MCQ Music Lessons: your subscription is now ' + newFrequency,
          '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>Your subscription has switched from ' + oldFrequency + ' to ' + newFrequency + '.' + (record.nextLessonDate ? ' Your next lesson on ' + formatFriendlyDate(record.nextLessonDate) + ' is unaffected, the new frequency applies from the one after that.' : '') + '</p><p>James</p>'
        );
      }
      await sendEmail(
        JAMES_EMAIL,
        'Frequency changed: ' + record.studentName,
        '<p>' + escapeHtml(record.studentName) + ' switched from ' + oldFrequency + ' to ' + newFrequency + '.</p>'
      );

      return { statusCode: 200, body: JSON.stringify({ success: true, frequency: newFrequency }) };
    }

    if (action === 'cancel') {
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      record.cancelling = true;
      await saveSubscriptionRecord(subscriptionId, record);
      return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Your subscription will end after your next paid lesson. No further charges will be made.' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Unknown action.' }) };
  } catch (err) {
    console.error('[manage-subscription] error:', err && err.message ? err.message : err);
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Something went wrong. Please try again.' }) };
  }
};
