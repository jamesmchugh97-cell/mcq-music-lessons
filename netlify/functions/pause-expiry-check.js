// pause-expiry-check.js
// Netlify SCHEDULED function (runs once daily). Finds any paused
// subscription whose pause window has ended and flips it back to
// 'active' in the live subscriptions store, which automatically
// re-locks their slot against other bookings. Stripe itself already
// resumes billing on its own at the resumes_at timestamp set when the
// pause was created (see manage-subscription.js) — this function only
// keeps our own slot-blocking record in sync with that, so the slot
// doesn't stay marked as free past the pause window James/students
// agreed to.
const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');

function subsStore() {
  return getStore({ name: 'subscriptions', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
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
      record.status = 'active';
      delete record.pausedUntil;
      await store.set(blob.key, JSON.stringify(record));
      resumedCount++;
      console.log('[pause-expiry-check] resumed subscription ' + record.subscriptionId + ' for ' + record.studentName);
    }
  }

  console.log('[pause-expiry-check] checked ' + blobs.length + ' subscriptions, resumed ' + resumedCount);
  return { statusCode: 200, body: 'ok' };
}

// Runs daily at 1:00am Melbourne-ish time (times are UTC on Netlify's
// scheduler, so this is roughly 11am/12pm UTC depending on the
// scheduler's own conventions — worth eyeballing the first few runs in
// the Netlify function logs to confirm timing feels right).
exports.handler = schedule('0 1 * * *', run);
