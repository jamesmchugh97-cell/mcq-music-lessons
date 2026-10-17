// create-gift-checkout.js
// Netlify serverless function: starts the Stripe payment for a gift voucher
// (a prepaid 5 or 10 lesson package someone buys for another person).
//
// The price is worked out HERE from the lesson count and length, never taken
// from the browser, so it can't be tampered with. Nothing is saved yet: the
// voucher is only made (and the code emailed) once Stripe reports that the
// payment actually went through - see handleGiftPurchase in stripe-webhook.js.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { voucherPriceCents } = require('./voucher-helpers');

function clean(value, max) {
  return String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body' }) };
  }

  const buyerName = clean(body.buyerName, 80);
  const buyerEmail = clean(body.buyerEmail, 200).toLowerCase();
  const recipientName = clean(body.recipientName, 80);
  const message = clean(body.message, 300);
  const lessonCount = parseInt(body.lessonCount, 10);
  const durationMinutes = parseInt(body.durationMinutes, 10);

  if (!buyerName) return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please enter your name.' }) };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please enter a valid email address - the voucher is sent there.' }) };
  }
  const amount = voucherPriceCents(lessonCount, durationMinutes);
  if (!amount) return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please choose a 5 or 10 lesson voucher and a lesson length.' }) };

  const siteUrl = process.env.URL || 'https://mcqmusiclessons.com.au';
  const label = lessonCount + ' x ' + durationMinutes + ' minute music lessons';
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: buyerEmail,
      line_items: [{
        price_data: {
          currency: 'aud',
          unit_amount: amount,
          product_data: { name: 'Gift voucher: ' + label, description: 'MCQ Music Lessons. Valid for 3 years; the lessons are booked whenever suits.' }
        },
        quantity: 1
      }],
      metadata: {
        mcq_gift: '1',
        buyerName: buyerName,
        buyerEmail: buyerEmail,
        recipientName: recipientName,
        message: message,
        lessonCount: String(lessonCount),
        durationMinutes: String(durationMinutes),
        amountCents: String(amount)
      },
      payment_intent_data: { description: 'Gift voucher: ' + label },
      success_url: siteUrl + '/gift.html?thanks=1',
      cancel_url: siteUrl + '/gift.html'
    });
    return { statusCode: 200, body: JSON.stringify({ success: true, url: session.url }) };
  } catch (err) {
    console.error('[create-gift-checkout] Stripe error:', err && err.message ? err.message : err);
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Could not start the payment. Please try again, or contact James.' }) };
  }
};
