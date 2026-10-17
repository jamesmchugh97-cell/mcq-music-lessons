// gift-voucher-reconcile.js
// Netlify SCHEDULED function, runs every 15 minutes. A safety net for the one
// thing that must never go wrong: someone pays for a gift voucher and doesn't
// get it.
//
// Normally the voucher is made the moment Stripe reports the payment
// (stripe-webhook.js). But that relies on Stripe's notification arriving and
// the booking system being up at that exact moment. So this job asks Stripe
// directly, every 15 minutes, for every gift voucher payment in the last 3
// days, and makes any voucher that is missing - using the very same function
// as the webhook, which does nothing for a payment that already has its
// voucher, so running it over and over can never make a second one.
const { schedule } = require('@netlify/functions');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { handleGiftPurchase } = require('./stripe-webhook');

const LOOKBACK_DAYS = 3;
const LEAVE_TO_WEBHOOK_SECONDS = 180; // a payment this fresh is still being handled normally

async function run() {
  const now = Math.floor(Date.now() / 1000);
  const since = now - LOOKBACK_DAYS * 86400;
  let startingAfter = null;
  let seen = 0, handled = 0, failed = 0;
  try {
    for (let page = 0; page < 5; page++) {
      const params = { created: { gte: since }, limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;
      const list = await stripe.checkout.sessions.list(params);
      for (const sess of list.data) {
        seen++;
        if (!sess.metadata || sess.metadata.mcq_gift !== '1' || sess.payment_status !== 'paid') continue;
        if (now - sess.created < LEAVE_TO_WEBHOOK_SECONDS) continue;
        try {
          await handleGiftPurchase(sess);
          handled++;
        } catch (e) {
          failed++;
          console.error('[gift-voucher-reconcile] could not make the voucher for', sess.id, ':', e && e.message ? e.message : e);
        }
      }
      if (!list.has_more) break;
      startingAfter = list.data[list.data.length - 1].id;
    }
  } catch (e) {
    console.error('[gift-voucher-reconcile] could not read checkout sessions from Stripe:', e && e.message ? e.message : e);
  }
  console.log('[gift-voucher-reconcile] looked at', seen, 'checkouts; gift payments checked:', handled, '; problems:', failed);
  return { statusCode: 200, body: 'ok' };
}

exports.handler = schedule('*/15 * * * *', run);
