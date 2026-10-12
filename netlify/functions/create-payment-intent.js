// Netlify serverless function: actually charges the card server-side.
// Requires a STRIPE_SECRET_KEY environment variable to be set in your
// Netlify site settings (Site configuration -> Environment variables).
// Use your Stripe SECRET key here (starts with sk_live_ or sk_test_),
// never the publishable key (pk_...) that's already in the HTML.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');
const { deleteCalendarEvent } = require('./google-calendar-helper');

// CRITICAL: this is the actual charge amount, computed here from
// values the server itself controls, never trusted from the request.
// The previous version took `amount` directly from the request body -
// meaning anyone with their browser's network tab open could rewrite
// that single number to 1 cent (or anything else) before it reached
// Stripe, and this function would have charged exactly that and
// confirmed success, with the booking then proceeding as if full price
// had been paid. The fix: the client only ever gets to say WHICH
// duration it wants, never WHAT IT COSTS - the price for that duration
// is looked up here, from a table only this server can change. Prices
// match what's shown throughout the site (pricing.html, the booking
// form's own duration dropdown, etc.) - update here if those ever
// change, since this is now the one place that actually decides what
// gets charged.
const DURATION_PRICES_CENTS = {
  30: 5000,
  45: 7000,
  60: 8500,
  75: 10000,
  90: 12000
};

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}
function normEmail(e) { return (e || '').trim().toLowerCase(); }

function slotMetadata(slots, email, maxLessons) {
  if (!Array.isArray(slots) || slots.length === 0 || !email) return undefined;
  const keys = slots.slice(0, maxLessons).filter(s => s && s.date && s.time).map(s => s.date + '_' + s.time);
  const joined = keys.join('|');
  if (!keys.length || joined.length > 450) return undefined;
  return { mcq_slots: joined, mcq_email: String(email).trim().slice(0, 200) };
}

// BEFORE charging: every slot this payment is for must currently be
// held, unpaid, by this same email. Catches the rare case where two
// people grabbed the exact same time in the same split second and the
// other person's hold replaced this one - they're told the time was
// taken and are never charged. Also stops someone paying twice for a
// lesson that's already confirmed.
async function checkSlotsHeld(slots, email) {
  if (!Array.isArray(slots) || slots.length === 0) return null; // older page version - nothing to check
  const store = bookingsStore();
  for (const s of slots) {
    if (!s || !s.date || !s.time) continue;
    const record = await store.get(s.date + '_' + s.time, { type: 'json' });
    if (!record || normEmail(record.email) !== normEmail(email)) {
      return s.date + ' at ' + s.time + ' was just taken by someone else a moment ago, so you have not been charged. Please pick a different time and try again.';
    }
    if (record.pendingPayment !== true) {
      return 'You already have ' + s.date + ' at ' + s.time + ' booked and paid for, so you have not been charged again. Check your email (and spam folder) for the confirmation.';
    }
  }
  return null;
}

// AFTER charging: links this payment to its slots and, when the charge
// has already fully succeeded, confirms them right here on the server.
// Previously confirmation depended entirely on the student's browser
// making a follow-up call to confirm-reservation after the charge; if
// they closed the tab, lost signal or the page errored in that gap, a
// PAID booking stayed marked as an unpaid hold and was deleted (with
// its calendar event) by pending-hold-cleanup 10-20 minutes later,
// reopening the slot to someone else. Stamping the paymentIntentId on
// each hold also lets the cleanup job check with Stripe before
// releasing anything (covers 3D Secure, where success only happens
// later in the browser).
// Returns false if any slot turned out not to be this student's after
// all (the split-second race above, landing between the check and the
// charge) - the caller then refunds.
async function linkAndConfirmSlots(slots, email, paymentIntent, maxLessons) {
  if (!Array.isArray(slots) || slots.length === 0) return true;
  const store = bookingsStore();
  const mine = [];
  for (const s of slots.slice(0, maxLessons)) {
    if (!s || !s.date || !s.time) continue;
    const key = s.date + '_' + s.time;
    const record = await store.get(key, { type: 'json' });
    if (!record || normEmail(record.email) !== normEmail(email)) return false;
    // Already confirmed for this very payment (Stripe's notification can
    // arrive before this function finishes): still ours, nothing to do.
    if (record.pendingPayment !== true && record.paymentIntentId !== paymentIntent.id) return false;
    if (record.pendingPayment !== true) continue;
    mine.push({ key, record });
  }
  const succeeded = paymentIntent.status === 'succeeded';
  let confirmed = 0;
  for (const { key, record } of mine) {
    try {
      record.paymentIntentId = paymentIntent.id;
      if (succeeded) {
        delete record.pendingPayment;
        delete record.reservedAt;
        confirmed++;
      }
      await store.set(key, JSON.stringify(record));
    } catch (e) {
      console.error('[create-payment-intent] could not link/confirm', key, ':', e && e.message ? e.message : e);
    }
  }
  if (confirmed > 0) {
    try {
      const cStore = getStore({ name: 'payment-confirmations', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
      await cStore.set(paymentIntent.id, JSON.stringify({ confirmedCount: confirmed }));
    } catch (e) {
      console.error('[create-payment-intent] could not record confirmation count:', e && e.message ? e.message : e);
    }
  }
  return true;
}

// Undo a charge that turned out to be for a slot this student doesn't
// hold, and release whatever holds of theirs are left from this request
// (so they don't sit there blocking the time for 20+ minutes).
async function undoChargeAndRelease(paymentIntent, slots, email) {
  try {
    if (paymentIntent.status === 'succeeded') {
      await stripe.refunds.create({ payment_intent: paymentIntent.id });
    } else {
      await stripe.paymentIntents.cancel(paymentIntent.id);
    }
  } catch (e) {
    console.error('[create-payment-intent] REFUND/CANCEL FAILED for', paymentIntent.id, '- refund manually in Stripe:', e && e.message ? e.message : e);
  }
  const store = bookingsStore();
  for (const s of (slots || [])) {
    if (!s || !s.date || !s.time) continue;
    const key = s.date + '_' + s.time;
    try {
      const record = await store.get(key, { type: 'json' });
      if (record && record.pendingPayment === true && normEmail(record.email) === normEmail(email)) {
        await store.delete(key);
        if (record.eventId) {
          try { await deleteCalendarEvent(record.eventId); } catch (e) {}
        }
      }
    } catch (e) {}
  }
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
  const { durationMinutes, lessonCount, payment_method_id, email, description, slots } = body;
  const pricePerLesson = DURATION_PRICES_CENTS[parseInt(durationMinutes, 10)];
  if (!pricePerLesson || !payment_method_id) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing or invalid lesson duration, or missing payment method.' }) };
  }
  // Only three shapes are valid: a single trial lesson, or a 5 or 10
  // lesson package paid upfront in one charge. lessonCount is checked
  // against this exact whitelist, never trusted as an arbitrary
  // multiplier - the same validation reserve-multi-slots.js applies
  // independently, so a mismatch here can never happen by accident,
  // and a deliberately hand-crafted request gets rejected outright
  // rather than silently charging the wrong amount.
  // A missing lessonCount defaults to 1 rather than failing: the trial
  // booking path legitimately doesn't send this field at all (a trial
  // is always exactly one lesson), so requiring it outright would
  // reject every genuine trial booking at the payment step.
  const VALID_LESSON_COUNTS = [1, 5, 10];
  const count = (lessonCount === undefined || lessonCount === null || lessonCount === '') ? 1 : parseInt(lessonCount, 10);
  if (!VALID_LESSON_COUNTS.includes(count)) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid lesson count.' }) };
  }
  const amount = pricePerLesson * count;
  try {
    const notHeld = await checkSlotsHeld(slots, email);
    if (notHeld) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: notHeld }) };
    }
  } catch (e) {
    console.error('[create-payment-intent] pre-charge slot check failed:', e && e.message ? e.message : e);
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Could not confirm your lesson time just now, so you have not been charged. Please try again.' }) };
  }
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // amount in cents (smallest currency unit), computed above - never taken from the request
      currency: 'aud',
      payment_method: payment_method_id,
      confirm: true,
      receipt_email: email || undefined,
      description: description || 'MCQ Music Lessons booking',
      // Tags this payment with the lesson slots it is for, so Stripe's
      // payment_intent.succeeded notification (stripe-webhook.js) can
      // confirm the booking and send the emails from the server, even if
      // the student's browser never gets to do it. Stripe caps each
      // metadata value at 500 characters, so it is left off (and the
      // browser path still works as before) if it would not fit.
      metadata: slotMetadata(slots, email, count),
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
    });
    let stillMine = true;
    try {
      stillMine = await linkAndConfirmSlots(slots, email, paymentIntent, count);
    } catch (linkErr) {
      console.error('[create-payment-intent] slot linking failed:', linkErr && linkErr.message ? linkErr.message : linkErr);
    }
    if (!stillMine) {
      await undoChargeAndRelease(paymentIntent, slots, email);
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Sorry, that time was taken by someone else at the very same moment. Your payment has been fully refunded (or cancelled before it went through). Please pick a different time.' }) };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        status: paymentIntent.status,
        client_secret: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id
      })
    };
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
