// confirm-reservation.js
// Netlify serverless function: called right after a one-off booking's
// payment actually succeeds, to clear the pendingPayment flag that
// reserve-multi-slots.js sets when it first locks in the slot. Without
// this, every successful booking would still look identical to an
// abandoned one from reserve-multi-slots.js's own stale-hold check,
// and could theoretically be treated as stale and released after
// RESERVATION_HOLD_MINUTES even though it's a real, paid booking.
// This is intentionally a separate, small step from the charge itself
// (create-payment-intent.js), so the two stay independent: payment
// logic doesn't need to know about slot bookkeeping, and this doesn't
// need to know about Stripe.
const { getStore } = require('@netlify/blobs');

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
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
  const slots = Array.isArray(body.slots) ? body.slots : [];
  if (slots.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'No slots provided.' }) };
  }

  const store = bookingsStore();
  let confirmed = 0;
  for (const s of slots) {
    if (!s || !s.date || !s.time) continue;
    const key = s.date + '_' + s.time;
    try {
      const record = await store.get(key, { type: 'json' });
      if (!record) continue;
      if (record.pendingPayment) {
        delete record.pendingPayment;
        delete record.reservedAt;
        await store.set(key, JSON.stringify(record));
        confirmed++;
      }
    } catch (e) {
      console.error('[confirm-reservation] failed to confirm', key, ':', e && e.message ? e.message : e);
    }
  }

  // Always returns success even if some slots were already confirmed or
  // missing - this is a best-effort cleanup step called after payment
  // has already succeeded, so failing the whole booking over it would
  // be the wrong tradeoff. Worst case, a slot stays marked pending for
  // a little longer than it should, which only matters if someone else
  // specifically wants that exact slot before the hold window elapses.
  return { statusCode: 200, body: JSON.stringify({ success: true, confirmed: confirmed }) };
};
