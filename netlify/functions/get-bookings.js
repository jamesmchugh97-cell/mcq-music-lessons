// Netlify serverless function: returns all currently booked lesson slots
// from Netlify Blobs, so the calendar shows real-time availability
// instead of a hardcoded list. Each entry includes its duration so the
// frontend can work out overlaps and minimum gaps correctly.
const { getStore } = require('@netlify/blobs');
// isStalePendingHold (see subscription-helpers.js) excludes abandoned,
// unpaid reservations from what the calendar shows as booked - without
// it, a failed or abandoned checkout would make a genuinely free slot
// look taken to every visitor until someone specifically tries to book
// that exact time and triggers the release elsewhere.
const { isStalePendingHold } = require('./subscription-helpers');
const { listAllSubscriptions } = require('./subscription-helpers');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
  try {
    const { blobs } = await store.list();
    const booked = {};
    for (const blob of blobs) {
      const record = await store.get(blob.key, { type: 'json' });
      if (record && record.date && record.time && !isStalePendingHold(record)) {
        if (!booked[record.date]) booked[record.date] = [];
        booked[record.date].push({ time: record.time, duration: record.duration || 45 });
      }
    }

    // An active subscription holds its weekly slot indefinitely, but only
    // the lesson Stripe has already invoiced exists as a dated record
    // above. Without this, the calendar showed every later week as free
    // even though every booking path on the server would refuse it, so
    // people filled in the whole form only to be rejected at the end.
    // Returned as recurring rules for the frontend to expand, rather than
    // as thousands of dated entries. Paused subscriptions are deliberately
    // left out: pausing is meant to free the slot up for that window.
    const subscriptions = [];
    try {
      const all = await listAllSubscriptions();
      all.forEach(record => {
        if (!record || record.status !== 'active') return;
        if (record.dayOfWeek === undefined || !record.time) return;
        subscriptions.push({
          dayOfWeek: parseInt(record.dayOfWeek, 10),
          time: record.time,
          duration: parseInt(record.durationMinutes, 10) || 45,
          frequency: record.frequency || 'weekly',
          anchorDate: record.nextLessonDate || null
        });
      });
    } catch (subErr) {
      // A failure here must not take the whole calendar down: dated
      // bookings are still worth returning on their own.
      console.error('[get-bookings] failed to load subscriptions:', subErr && subErr.message ? subErr.message : subErr);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, booked, subscriptions })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'Failed to load bookings' })
    };
  }
};
