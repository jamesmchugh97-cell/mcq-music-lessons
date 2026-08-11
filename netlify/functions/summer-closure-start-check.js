// summer-closure-start-check.js
// Netlify SCHEDULED function (runs once daily). Two independent checks
// in one file, both answering "does a scheduled future pause need to
// actually start today":
// 1. Individual students who booked their summer break in advance
//    (manage-subscription.js's pauseSummer action) - once
//    SUMMER_PAUSE_START arrives, their Stripe billing is actually
//    paused now, since pause_collection can't be scheduled for a
//    future start date directly, only called the moment it should
//    take effect.
// 2. A studio-wide closure set by James via admin-closure.js - once its
//    start date arrives, every currently-active subscription is paused
//    the same way, tagged so it's clear why.
// Both resume automatically later via the EXISTING pause-expiry-check.js
// job, which only cares about a record's status/pausedUntil fields, not
// why it was paused in the first place, so nothing new was needed there.
const { schedule } = require('@netlify/functions');
const Stripe = require('stripe');
const {
  listAllSubscriptions,
  saveSubscriptionRecord,
  getClosureSettings,
  saveClosureSettings,
  SUMMER_PAUSE_START,
  clearImminentLessonIfWithinPause
} = require('./subscription-helpers');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

async function pauseSubscription(record, endDateStr, reason) {
  const resumeEpoch = Math.floor(new Date(endDateStr + 'T00:00:00').getTime() / 1000);
  await stripe.subscriptions.update(record.subscriptionId, {
    pause_collection: { behavior: 'void', resumes_at: resumeEpoch }
  });
  record.status = 'paused';
  record.pausedUntil = endDateStr;
  record.pausedReason = reason;
  await saveSubscriptionRecord(record.subscriptionId, record);
  // Same handling as a student's own last-minute pause - if an already-
  // booked lesson now falls inside this window, it's cleared off the
  // calendar rather than left dangling.
  try {
    await clearImminentLessonIfWithinPause(record, endDateStr);
  } catch (e) {
    console.error('[summer-closure-start-check] failed to clear imminent lesson for', record.subscriptionId, ':', e && e.message ? e.message : e);
  }
}

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  const allSubs = await listAllSubscriptions();

  // 1. Individual summer-pause requests whose start date has arrived
  let summerStarted = 0;
  if (today >= SUMMER_PAUSE_START) {
    for (const record of allSubs) {
      if (record.summerPausePending && record.status === 'active') {
        delete record.summerPausePending;
        await pauseSubscription(record, record.summerPauseEndDate, 'summer_break');
        summerStarted++;
      }
    }
  }

  // 2. Studio-wide closure, if one is set, its start date has arrived,
  // and it hasn't already been applied (the "applied" flag stops this
  // re-running every single day of the closure and re-pausing anyone
  // who deliberately un-paused themselves partway through for some
  // other reason).
  let closureStarted = 0;
  const closure = await getClosureSettings();
  if (closure && !closure.applied && today >= closure.startDate) {
    // Re-check allSubs in memory, not a fresh fetch - anyone already
    // flipped to 'paused' by the summer-pause loop above is correctly
    // skipped here rather than being paused a second time.
    for (const record of allSubs) {
      if (record.status === 'active') {
        await pauseSubscription(record, closure.endDate, 'studio_closure');
        closureStarted++;
      }
    }
    closure.applied = true;
    await saveClosureSettings(closure);
  }

  console.log('[summer-closure-start-check] summer pauses started: ' + summerStarted + ', closure pauses started: ' + closureStarted);
  return { statusCode: 200, body: 'ok' };
}

exports.handler = schedule('0 1 * * *', run);
