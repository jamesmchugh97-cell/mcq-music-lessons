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
  pausedWeeksThisYear,
  currentYear
} = require('./subscription-helpers');
const { getStore } = require('@netlify/blobs');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function subsStore() {
  return getStore({ name: 'subscriptions', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

async function findSubscriptionsByEmail(email) {
  const store = subsStore();
  const emailLower = email.trim().toLowerCase();
  const { blobs } = await store.list({ prefix: 'sub_' });
  const results = [];
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' });
    if (record && (record.studentEmail || '').trim().toLowerCase() === emailLower) {
      results.push(record);
    }
  }
  return results;
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
      const subs = await findSubscriptionsByEmail(email);
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
        pauseWeeksRemaining: 4 - pausedWeeksThisYear(s),
        nextLessonDate: s.nextLessonDate || null,
        cancelling: !!s.cancelling
      }));
      return { statusCode: 200, body: JSON.stringify({ success: true, subscriptions: summarized }) };
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
      if (!weeks || weeks < 1 || weeks > 4) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please choose between 1 and 4 weeks.' }) };
      }
      if (record.status === 'paused') {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'This subscription is already paused.' }) };
      }
      if (!canPauseWeeks(record, weeks)) {
        const remaining = 4 - pausedWeeksThisYear(record);
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'You only have ' + remaining + ' pause week(s) left this year.' }) };
      }

      const resumeDate = new Date();
      resumeDate.setDate(resumeDate.getDate() + weeks * 7);
      const resumesAtEpoch = Math.floor(resumeDate.getTime() / 1000);

      await stripe.subscriptions.update(subscriptionId, {
        pause_collection: { behavior: 'void', resumes_at: resumesAtEpoch }
      });

      const usedBefore = pausedWeeksThisYear(record);
      record.status = 'paused';
      record.pausedUntil = resumeDate.toISOString().slice(0, 10);
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

      return { statusCode: 200, body: JSON.stringify({ success: true, pausedUntil: record.pausedUntil, pauseWeeksRemaining: 4 - record.pausedWeeksThisYear }) };
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
