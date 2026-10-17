// Netlify serverless function: actually charges the card server-side.
// Requires a STRIPE_SECRET_KEY environment variable to be set in your
// Netlify site settings (Site configuration -> Environment variables).
// Use your Stripe SECRET key here (starts with sk_live_ or sk_test_),
// never the publishable key (pk_...) that's already in the HTML.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
  90: 13000
};

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
  const { durationMinutes, lessonCount, payment_method_id, email, description } = body;
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
  const VALID_LESSON_COUNTS = [1, 5, 10];
  const count = parseInt(lessonCount, 10);
  if (!VALID_LESSON_COUNTS.includes(count)) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid lesson count.' }) };
  }
  const amount = pricePerLesson * count;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // amount in cents (smallest currency unit), computed above - never taken from the request
      currency: 'aud',
      payment_method: payment_method_id,
      confirm: true,
      receipt_email: email || undefined,
      description: description || 'MCQ Music Lessons booking',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
    });
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
