// subscription-payment-grace-check.js
// Netlify scheduled function (runs daily): finds subscriptions with an
// unresolved payment failure and, once PAYMENT_GRACE_PERIOD_DAYS have
// passed since the first failure with no successful retry in between,
// automatically cancels the subscription so the slot is freed up for
// booking rather than sitting reserved for a non-paying student
// indefinitely. Sends one reminder email partway through the grace
// period (at PAYMENT_REMINDER_AFTER_DAYS) so the student isn't caught
// off guard by a sudden cutoff.
//
// This works alongside stripe-webhook.js: that file records
// paymentFailedAt on the FIRST invoice.payment_failed event in a cycle
// (and clears it again the moment a renewal payment succeeds), this
// function is what actually acts on it once the grace period has run
// out. Cancelling the subscription here triggers Stripe's
// customer.subscription.deleted event, which stripe-webhook.js already
// handles in full - deleting the subscription record, freeing the slot,
// and emailing the student that their subscription has ended - so this
// function doesn't duplicate that cleanup, it just starts it.
const { schedule } = require('@netlify/functions');
const Stripe = require('stripe');
const {
  listAllSubscriptions,
  saveSubscriptionRecord,
  PAYMENT_GRACE_PERIOD_DAYS,
  PAYMENT_REMINDER_AFTER_DAYS
} = require('./subscription-helpers');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

async function sendEmail(to, subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>',
        to: [to],
        subject: subject,
        html: html
      })
    });
  } catch (e) {
    console.error('[subscription-payment-grace-check] email send failed:', e && e.message ? e.message : e);
  }
}

function daysSince(isoString) {
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60 * 24);
}

exports.handler = schedule('@daily', async (event) => {
  try {
    const subs = await listAllSubscriptions();

    for (const record of subs) {
      if (record.status !== 'active' || !record.paymentFailedAt) continue;
      const daysElapsed = daysSince(record.paymentFailedAt);

      if (daysElapsed >= PAYMENT_GRACE_PERIOD_DAYS) {
        console.log('[subscription-payment-grace-check] releasing slot for ' + record.subscriptionId + ' (' + record.studentName + ') after ' + Math.floor(daysElapsed) + ' unresolved days');
        try {
          // Cancelling here triggers customer.subscription.deleted,
          // which stripe-webhook.js already handles end to end.
          await stripe.subscriptions.cancel(record.subscriptionId);
        } catch (cancelErr) {
          console.error('[subscription-payment-grace-check] cancel failed for ' + record.subscriptionId + ':', cancelErr && cancelErr.message ? cancelErr.message : cancelErr);
        }
        continue;
      }

      if (daysElapsed >= PAYMENT_REMINDER_AFTER_DAYS && !record.paymentFailureReminderSent) {
        const daysLeft = Math.max(1, Math.ceil(PAYMENT_GRACE_PERIOD_DAYS - daysElapsed));
        await sendEmail(
          record.studentEmail,
          'MCQ Music Lessons: action needed on your subscription payment',
          '<p>Hi ' + record.studentName + ',</p><p>Your subscription payment still hasn\'t gone through. Please update your card details as soon as you can. If this isn\'t resolved within the next ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ', your slot will be automatically released. You can check or update your subscription from your <a href="https://mcqmusiclessons.com.au/booking.html#manage-subscription">Manage Subscription</a> page.</p><p>James</p>'
        );
        await sendEmail(
          JAMES_EMAIL,
          'Payment reminder sent: ' + record.studentName,
          '<p>' + record.studentName + '\'s payment is still unresolved after ' + Math.floor(daysElapsed) + ' days. A reminder email was just sent to them. Their slot will be automatically released in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' if it\'s still unresolved.</p>'
        );
        record.paymentFailureReminderSent = true;
        await saveSubscriptionRecord(record.subscriptionId, record);
      }
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[subscription-payment-grace-check] handler error:', err && err.message ? err.message : err);
    return { statusCode: 200, body: 'ok' };
  }
});
