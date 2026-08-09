// stripe-webhook.js
// Netlify serverless function: receives events from Stripe about
// subscription billing (a payment succeeded, a payment failed, or a
// subscription was cancelled) and reacts automatically, so James never
// has to manually track or chase subscription payments.
//
// Each Stripe Subscription is expected to carry metadata set at
// subscribe time describing the lesson slot it represents:
//   studentName, studentEmail, instrument, dayOfWeek (0-6), time
//   (e.g. "4:00 pm"), durationMinutes, frequency ("weekly" or
//   "fortnightly")
// This metadata is what lets the webhook know which slot to create a
// calendar event and booking record for each time a payment succeeds.
const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');
const { createCalendarEvent, deleteCalendarEvent } = require('./google-calendar-helper');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

function minutesToIsoClock(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00';
}

function timeToMinutes(t) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

function formatDateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Given a subscription's metadata, works out the actual calendar date of
// the NEXT lesson from today, matching the subscription's day-of-week.
function nextLessonDate(dayOfWeek) {
  const d = new Date();
  const currentDow = d.getDay();
  let daysAhead = (dayOfWeek - currentDow + 7) % 7;
  if (daysAhead === 0) daysAhead = 0; // if today is the day, book today's date
  d.setDate(d.getDate() + daysAhead);
  return formatDateKey(d);
}

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
  } catch (e) {}
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return { statusCode: 400, body: 'Webhook signature verification failed' };
  }

  console.log('[stripe-webhook] received event:', stripeEvent.type);

  try {
    if (stripeEvent.type === 'invoice.payment_succeeded') {
      const invoice = stripeEvent.data.object;
      const subscriptionId = invoice.subscription;
      if (!subscriptionId) {
        return { statusCode: 200, body: 'ok (no subscription on invoice)' };
      }
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const meta = subscription.metadata || {};
      if (!meta.studentEmail || meta.dayOfWeek === undefined || !meta.time || !meta.durationMinutes) {
        console.error('[stripe-webhook] subscription missing required metadata:', subscriptionId);
        return { statusCode: 200, body: 'ok (missing metadata, skipped)' };
      }

      const durationMinutes = parseInt(meta.durationMinutes, 10) || 45;
      const dayOfWeek = parseInt(meta.dayOfWeek, 10);
      const date = nextLessonDate(dayOfWeek);
      const key = date + '_' + meta.time;

      const record = {
        date: date,
        time: meta.time,
        duration: durationMinutes,
        name: meta.studentName || '',
        email: meta.studentEmail,
        subscriptionId: subscriptionId,
        bookedAt: new Date().toISOString()
      };

      // Reserve the slot the same way a normal booking does, atomically,
      // so a subscription payment can never silently double-book on top
      // of something else.
      const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
      let claimed = true;
      try {
        const result = await store.set(key, JSON.stringify(record), { onlyIfNew: true });
        if (result && result.modified === false) claimed = false;
      } catch (e) {
        claimed = false;
      }

      if (claimed) {
        try {
          const startMinutes = timeToMinutes(meta.time);
          const endMinutes = startMinutes + durationMinutes;
          const startDateTime = date + 'T' + minutesToIsoClock(startMinutes);
          const endDateTime = date + 'T' + minutesToIsoClock(endMinutes);
          const eventId = await createCalendarEvent({
            studentName: meta.studentName || 'Subscriber',
            startDateTime: startDateTime,
            endDateTime: endDateTime,
            notes: 'Subscription lesson, paid via Stripe subscription ' + subscriptionId
          });
          if (eventId) {
            record.eventId = eventId;
            await store.set(key, JSON.stringify(record));
          }
        } catch (calErr) {
          console.error('[stripe-webhook] calendar event creation failed:', calErr && calErr.message ? calErr.message : calErr);
        }
      } else {
        console.error('[stripe-webhook] slot already taken for subscription lesson:', key, '- subscription:', subscriptionId);
      }

      return { statusCode: 200, body: 'ok' };
    }

    if (stripeEvent.type === 'invoice.payment_failed') {
      const invoice = stripeEvent.data.object;
      const subscriptionId = invoice.subscription;
      if (!subscriptionId) return { statusCode: 200, body: 'ok (no subscription)' };
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const meta = subscription.metadata || {};
      if (!meta.studentEmail) return { statusCode: 200, body: 'ok (no email on metadata)' };

      const studentHtml =
        '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">' +
        '<h2 style="text-align:center;font-family:Georgia,serif;font-weight:normal;">Payment Failed</h2>' +
        '<p>Hi ' + (meta.studentName || 'there') + ',</p>' +
        '<p>Your lesson subscription payment didn\u2019t go through. Please update your card details to keep your weekly time secured.</p>' +
        '<p style="font-size:0.85em;color:#666;">Questions? Reply to this email or call 0499 232 898.</p>' +
        '</div>';
      await sendEmail(meta.studentEmail, 'Payment failed for your lesson subscription', studentHtml);

      const jamesHtml =
        '<div style="font-family:-apple-system,sans-serif;">' +
        '<h3>Subscription payment failed</h3>' +
        '<p><strong>' + (meta.studentName || 'A student') + '</strong> (' + meta.studentEmail + ')\u2019s subscription payment failed. Stripe will automatically retry.</p>' +
        '</div>';
      await sendEmail('jamesmcqmusic@gmail.com', 'Subscription payment failed: ' + (meta.studentName || meta.studentEmail), jamesHtml);

      return { statusCode: 200, body: 'ok' };
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const subscription = stripeEvent.data.object;
      const meta = subscription.metadata || {};
      if (!meta.studentEmail) return { statusCode: 200, body: 'ok (no email on metadata)' };

      const studentHtml =
        '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">' +
        '<h2 style="text-align:center;font-family:Georgia,serif;font-weight:normal;">Subscription Ended</h2>' +
        '<p>Hi ' + (meta.studentName || 'there') + ',</p>' +
        '<p>Your weekly lesson subscription has ended, so your regular time slot is no longer held. If this wasn\u2019t intentional, or you\u2019d like to resubscribe, just reply to this email.</p>' +
        '<p style="font-size:0.85em;color:#666;">Questions? Reply to this email or call 0499 232 898.</p>' +
        '</div>';
      await sendEmail(meta.studentEmail, 'Your lesson subscription has ended', studentHtml);

      const jamesHtml =
        '<div style="font-family:-apple-system,sans-serif;">' +
        '<h3>Subscription ended</h3>' +
        '<p><strong>' + (meta.studentName || 'A student') + '</strong> (' + meta.studentEmail + ')\u2019s subscription has ended (cancelled, or payment retries exhausted). Their regular slot is now free.</p>' +
        '</div>';
      await sendEmail('jamesmcqmusic@gmail.com', 'Subscription ended: ' + (meta.studentName || meta.studentEmail), jamesHtml);

      return { statusCode: 200, body: 'ok' };
    }

    return { statusCode: 200, body: 'ok (unhandled event type)' };
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err && err.message ? err.message : err);
    // Always return 200 to Stripe even on our own internal errors, so
    // Stripe doesn't endlessly retry-storm an event that will keep
    // failing for a reason on our end, not theirs. Errors are still
    // fully logged above for us to catch and fix.
    return { statusCode: 200, body: 'error logged' };
  }
};
