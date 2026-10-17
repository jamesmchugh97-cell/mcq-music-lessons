// pending-hold-cleanup.js
// Netlify SCHEDULED function, runs every 30 minutes. Proactively sweeps
// every booking record in the store looking for stale, abandoned
// pending-payment holds (see isStalePendingHold in
// subscription-helpers.js) and cleans up both the booking record AND
// its Google Calendar event.
//
// Every place that CHECKS for a conflict already treats a stale hold
// as if it weren't there - but nothing was ever proactively removing
// the underlying record or its calendar event unless someone else
// happened to try booking that exact same date and time again later.
// If nobody ever contests that slot, an abandoned checkout (a failed
// card, a closed tab, anything short of completing payment) would
// leave a real-looking event sitting on James's calendar forever,
// showing a student as booked in who never actually paid - directly
// undermining the calendar as an accurate, trustworthy record of who's
// actually booked without having to dig through email or Stripe.
const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');
const { isStalePendingHold } = require('./subscription-helpers');
const { deleteCalendarEvent } = require('./google-calendar-helper');

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

async function run() {
  const store = bookingsStore();
  let swept = 0;
  let checked = 0;
  try {
    const { blobs } = await store.list();
    for (const blob of blobs) {
      checked++;
      let record;
      try {
        record = await store.get(blob.key, { type: 'json' });
      } catch (e) {
        console.error('[pending-hold-cleanup] failed to read', blob.key, ':', e && e.message ? e.message : e);
        continue;
      }
      if (!isStalePendingHold(record)) continue;
      try {
        await store.delete(blob.key);
        if (record.eventId) {
          try {
            await deleteCalendarEvent(record.eventId);
          } catch (calErr) {
            console.error('[pending-hold-cleanup] calendar delete failed for', blob.key, ':', calErr && calErr.message ? calErr.message : calErr);
          }
        }
        swept++;
        console.log('[pending-hold-cleanup] swept stale hold at', blob.key, 'reserved at', record.reservedAt);
      } catch (e) {
        console.error('[pending-hold-cleanup] failed to delete', blob.key, ':', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    console.error('[pending-hold-cleanup] failed to list bookings store:', e && e.message ? e.message : e);
  }
  console.log('[pending-hold-cleanup] checked', checked, 'records, swept', swept, 'stale holds');
  return { statusCode: 200, body: 'ok' };
}

exports.handler = schedule('*/30 * * * *', run);
