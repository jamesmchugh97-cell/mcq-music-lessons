// confirm-reservation.js
// Netlify serverless function: called right after a one-off booking's
// payment actually succeeds, to clear the pendingPayment flag that
// reserve-multi-slots.js sets when it first locks in the slot. Without
// this, every successful booking would still look identical to an
// abandoned one from reserve-multi-slots.js's own stale-hold check,
// and could theoretically be treated as stale and released after
// RESERVATION_HOLD_MINUTES even though it's a real, paid booking.
//
// SECURITY: this used to just clear pendingPayment on whatever slots
// the request listed, with no check that they were actually paid for.
// Since these are public HTTP endpoints, not something only the site's
// own JS can call, anyone could reserve several lessons, pay for one,
// then call this directly with all of them and get the rest confirmed
// for free - the same class of bug as the payment-amount vulnerability
// fixed in create-payment-intent.js, just one step further down the
// chain. Fixed the same way: never trust the client's claim about what
// was paid for. This now requires the actual Stripe payment_intent_id,
// verifies it genuinely succeeded, and computes from its real charged
// amount how many lessons it can legitimately cover - confirming at
// most that many slots, however many the request lists. A small store
// tracks how many slots each payment_intent_id has already confirmed,
// so the same successful payment can't be replayed against a second,
// different batch of slots to confirm more than it ever paid for.
const { getStore } = require('@netlify/blobs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Must match create-payment-intent.js's own DURATION_PRICES_CENTS -
// duplicated rather than imported from a shared module, since this and
// create-payment-intent.js are both on the critical, latency-sensitive
// payment path and a heavier shared dependency chain isn't worth it for
// one small, rarely-changing table. Update both together if prices ever
// change.
const DURATION_PRICES_CENTS = {
  30: 5000,
  45: 7000,
  60: 8500,
  75: 10000,
  90: 13000
};

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}
function confirmationsStore() {
  return getStore({ name: 'payment-confirmations', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
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
  const paymentIntentId = body.payment_intent_id;
  const pricePerLesson = DURATION_PRICES_CENTS[parseInt(body.durationMinutes, 10)];
  if (slots.length === 0 || !paymentIntentId || !pricePerLesson) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing slots, payment reference, or duration.' }) };
  }

  // Verify this is a real, genuinely successful payment - never trust
  // the request's own claim about that.
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Could not verify payment.' }) };
  }
  if (!paymentIntent || paymentIntent.status !== 'succeeded') {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Payment has not succeeded.' }) };
  }

  const cStore = confirmationsStore();
  const existingConfirmation = await cStore.get(paymentIntentId, { type: 'json' });
  const alreadyConfirmed = (existingConfirmation && existingConfirmation.confirmedCount) || 0;
  const totalLessonsThisPaymentCovers = Math.floor(paymentIntent.amount / pricePerLesson);
  const remainingAllowance = totalLessonsThisPaymentCovers - alreadyConfirmed;

  const store = bookingsStore();
  let confirmed = 0;
  for (const s of slots) {
    if (confirmed >= remainingAllowance) break; // this payment has already covered as many slots as it legitimately can
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

  if (confirmed > 0) {
    await cStore.set(paymentIntentId, JSON.stringify({ confirmedCount: alreadyConfirmed + confirmed }));
  }

  // Always returns success even if some slots were already confirmed or
  // missing - this is a best-effort cleanup step called after payment
  // has already succeeded, so failing the whole booking over it would
  // be the wrong tradeoff. Worst case, a slot stays marked pending for
  // a little longer than it should, which only matters if someone else
  // specifically wants that exact slot before the hold window elapses.
  return { statusCode: 200, body: JSON.stringify({ success: true, confirmed: confirmed }) };
};
