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
const {
  timeToMinutes,
  createLessonOccurrence,
  getSubscriptionRecord,
  saveSubscriptionRecord,
  deleteSubscriptionRecord,
  listBlockingSubscriptionsForDay,
  conflictsWithSubscriptions,
  nextOccurrenceDate,
  nextRenewalDate,
  currentYear,
  PAYMENT_GRACE_PERIOD_DAYS,
  getEmailHistory,
  saveEmailHistory,
  pausedWeeksThisYear,
  summerWeeksUsed,
  inheritedPauseWeeksForNewSubscription,
  isStalePendingHold,
  escapeHtml
} = require('./subscription-helpers');

const { handler: sendConfirmationEmail } = require('./send-confirmation-email');
const voucherHelpers = require('./voucher-helpers');
const emailTemplate = require('./email-template');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const MIN_NOTICE_HOURS = 24;
// Mirrors the pricing tiers used everywhere else on the site, so
// subscription emails can quote the actual per-lesson price without
// needing a live Stripe lookup.
const PRICE_BY_DURATION = { '30': 50, '45': 70, '60': 85, '75': 100, '90': 120 };

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

// Formats a 'YYYY-MM-DD' date string into something readable in an
// email, e.g. 'Monday, 17 August 2026', instead of showing students the
// raw machine-format date.
function formatFriendlyDate(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// Builds a one-click "add to your own calendar" link for a subscription's
// recurring slot, separate from the Google Calendar sync James's own
// bookings calendar already has. Includes an RRULE so the student's own
// calendar shows it repeating every week or fortnight, not just once.
function buildGoogleCalendarLink(title, dateStr, timeStr, durationMinutes, frequency) {
  const startMin = timeToMinutes(timeStr);
  if (startMin === null || !dateStr) return null;
  const endMin = startMin + (parseInt(durationMinutes, 10) || 45);
  const toGcal = (mins) => {
    const h = Math.floor(mins / 60), m = mins % 60;
    return dateStr.replace(/-/g, '') + 'T' + String(h).padStart(2, '0') + String(m).padStart(2, '0') + '00';
  };
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: toGcal(startMin) + '/' + toGcal(endMin),
    details: 'Lesson with James McHugh, MCQ Music Lessons.',
    location: '84 Nelson Rd, South Melbourne VIC 3205',
    ctz: 'Australia/Melbourne',
    recur: 'RRULE:FREQ=WEEKLY' + (frequency === 'fortnightly' ? ';INTERVAL=2' : '')
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

async function sendEmail(to, subject, html, text) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>', reply_to: 'jamesmcqmusic@gmail.com',
        to: [to],
        subject: subject,
        html: html,
        ...(text ? { text: text } : {})
      })
    });
  } catch (e) {
    console.error('[stripe-webhook] email send failed:', e && e.message ? e.message : e);
  }
}

const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

// Checks whether the given weekday/time slot is free of OTHER active
// subscriptions right now, the last line of defence against two
// students both completing checkout for the same slot at nearly the
// same moment.
async function slotStillFree(dow, time, durationMinutes, excludeSubscriptionId) {
  const startMinutes = timeToMinutes(time);
  const endMinutes = startMinutes + parseInt(durationMinutes, 10);
  // Includes paused subscribers, not just active ones - a new
  // subscription shouldn't be able to slip through onto a paused
  // student's slot even in the narrow window between the initial
  // create-subscription.js check and Stripe Checkout actually
  // completing (e.g. if that other student paused during that window).
  const blocking = await listBlockingSubscriptionsForDay(dow, excludeSubscriptionId, ['active', 'paused']);
  return !conflictsWithSubscriptions(blocking, startMinutes, endMinutes);
}


// Checks a specific date/time against the one-off "bookings" store, the
// counterpart to slotStillFree() above which only checks OTHER
// subscribers. Needed because a one-off booking can be made through the
// normal form at any moment, including the few seconds between a new
// subscriber starting Stripe Checkout and their payment actually
// confirming, before any subscription record exists yet to block it.
async function oneOffBookingConflict(dateStr, time, durationMinutes) {
  const store = bookingsStore();
  const { blobs } = await store.list({ prefix: dateStr + '_' });
  const startMinutes = timeToMinutes(time);
  const endMinutes = startMinutes + parseInt(durationMinutes, 10);
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' });
    if (!record || !record.time || isStalePendingHold(record)) continue;
    const exStart = timeToMinutes(record.time);
    const exEnd = exStart + (record.duration || 45);
    if (startMinutes < exEnd && exStart < endMinutes) return true;
  }
  return false;
}

// One-off lessons, packages and trial lessons (not weekly enrollments,
// which are handled by invoice.payment_succeeded below). Stripe tells us
// the moment a lesson payment succeeds, so the booking is confirmed and
// the emails go out from here - the student's browser is no longer the
// only thing that can do it, so closing the tab right after paying
// can't leave a paid booking half-finished.
//   - every slot still this student's -> confirm it and send the emails
//   - none of them still theirs (the hold was released and someone else
//     took the time, e.g. a bank check that took too long) -> refund in
//     full and tell the student and James
//   - some but not all (packages) -> confirm what is theirs and alert
//     James to sort out the rest, since splitting a payment is his call
async function handleLessonPaymentSucceeded(pi) {
  const meta = pi.metadata || {};
  if (!meta.mcq_slots || !meta.mcq_email) return; // not one of these payments (e.g. a subscription invoice)
  const keys = String(meta.mcq_slots).split('|').filter(Boolean);
  const payerEmail = String(meta.mcq_email).trim();
  const payerLower = payerEmail.toLowerCase();
  if (!keys.length) return;

  const store = bookingsStore();
  const mine = [];
  const notMine = [];
  for (const key of keys) {
    const record = await store.get(key, { type: 'json' });
    const sameEmail = record && (record.email || '').trim().toLowerCase() === payerLower;
    // A record carrying a DIFFERENT payment's id belongs to someone else's attempt.
    const otherPayment = record && record.paymentIntentId && record.paymentIntentId !== pi.id;
    if (sameEmail && !otherPayment) mine.push({ key, record }); else notMine.push(key);
  }

  const niceSlot = (key) => {
    const i = key.indexOf('_');
    return formatFriendlyDate(key.slice(0, i)) + ' at ' + key.slice(i + 1);
  };

  if (mine.length === 0) {
    try {
      await stripe.refunds.create({ payment_intent: pi.id }, { idempotencyKey: 'mcq-lost-slot-' + pi.id });
    } catch (refundErr) {
      console.error('[stripe-webhook] REFUND FAILED for lost-slot payment', pi.id, '- refund manually in Stripe:', refundErr && refundErr.message ? refundErr.message : refundErr);
    }
    await sendEmail(
      payerEmail,
      'MCQ Music Lessons: your payment has been refunded',
      '<p>Hi,</p><p>Sorry about this: the time you booked (' + escapeHtml(keys.map(niceSlot).join('; ')) + ') was released while your payment was still being completed, and has since been taken by someone else. Your payment has been <strong>fully refunded</strong> and should reach your card within 5-10 business days.</p><p>You are welcome to <a href="https://mcqmusiclessons.com.au/booking.html#calendar" style="color:#c9942a;">book another time</a> - or just reply to this email and James will help.</p>'
    );
    await sendEmail(
      JAMES_EMAIL,
      'Refunded a payment: time was taken (' + payerEmail + ')',
      '<p>A payment from <strong>' + escapeHtml(payerEmail) + '</strong> succeeded after the time they booked (' + escapeHtml(keys.map(niceSlot).join('; ')) + ') had been released and given to someone else. It was refunded automatically and they were emailed. Payment: ' + escapeHtml(pi.id) + '.</p>'
    );
    return;
  }

  // Confirm what is theirs (safe to repeat - Stripe can deliver an event twice).
  let confirmedNow = 0;
  for (const m of mine) {
    if (m.record.pendingPayment || m.record.paymentIntentId !== pi.id) {
      delete m.record.pendingPayment;
      delete m.record.reservedAt;
      m.record.paymentIntentId = pi.id;
      await store.set(m.key, JSON.stringify(m.record));
      confirmedNow++;
    }
  }
  if (confirmedNow > 0) {
    // Keeps the browser's own confirm step (confirm-reservation.js) from counting these twice.
    try {
      const cStore = getStore({ name: 'payment-confirmations', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
      const existing = await cStore.get(pi.id, { type: 'json' });
      const already = (existing && existing.confirmedCount) || 0;
      if (already < mine.length) await cStore.set(pi.id, JSON.stringify({ confirmedCount: mine.length }));
    } catch (e) {}
  }

  if (notMine.length > 0) {
    await sendEmail(
      JAMES_EMAIL,
      'ACTION NEEDED: a package payment is missing some lessons (' + payerEmail + ')',
      '<p><strong>' + escapeHtml(payerEmail) + '</strong> paid for ' + keys.length + ' lesson(s) but ' + notMine.length + ' of them are no longer theirs: ' + escapeHtml(notMine.map(niceSlot).join('; ')) + '. The other ' + mine.length + ' are confirmed. No confirmation email was sent to them. You may need to give a partial refund or rebook them. Payment: ' + escapeHtml(pi.id) + '.</p>'
    );
    return;
  }

  const first = mine[0].record;
  const dollars = pi.amount / 100;
  await sendConfirmationEmail({
    httpMethod: 'POST',
    body: JSON.stringify({
      name: first.name,
      email: first.email,
      instrument: first.instrument,
      guitar_type: first.guitarType,
      date: first.date,
      time: first.time,
      duration: first.duration,
      lessons_count: mine.length,
      total: '$' + (Number.isInteger(dollars) ? dollars : dollars.toFixed(2)),
      slots: mine.map(m => ({ date: m.record.date, time: m.record.time })),
      skill_level: first.skillLevel,
      song_requests: first.songRequests,
      genre_focus: first.genreFocus,
      theory_interest: first.theoryInterest,
      lesson_goals_notes: first.goalsNotes
    })
  });
}

// A gift voucher has been paid for (see create-gift-checkout.js): make the
// voucher, store it, and email the buyer their code. Safe to run more than
// once for the same payment - Stripe can report a checkout more than once, so
// each checkout session claims itself first and only the first one makes a
// voucher.
async function handleGiftPurchase(sess) {
  const meta = sess.metadata || {};
  if (meta.mcq_gift !== '1' || sess.payment_status !== 'paid') return;
  const lessonCount = parseInt(meta.lessonCount, 10);
  const durationMinutes = parseInt(meta.durationMinutes, 10);
  const expected = voucherHelpers.voucherPriceCents(lessonCount, durationMinutes);
  if (!expected || sess.amount_total !== expected) {
    console.error('[stripe-webhook] gift payment amount did not match for session', sess.id, 'expected', expected, 'got', sess.amount_total);
    await sendEmail(JAMES_EMAIL, 'ACTION NEEDED: a gift voucher payment did not match its price',
      '<p>A gift voucher payment came through for an amount that does not match the voucher chosen, so <strong>no voucher was made</strong>. Checkout session: ' + escapeHtml(sess.id) + '. Amount paid: ' + escapeHtml(String(sess.amount_total)) + ' cents. Buyer: ' + escapeHtml(meta.buyerEmail || '') + '. Please check it in Stripe.</p>');
    return;
  }

  const index = voucherHelpers.sessionIndexStore();
  const mark = require('crypto').randomBytes(8).toString('hex');
  const already = await index.get(sess.id, { type: 'json' });
  // Done already (the voucher exists), or another delivery is part way through making it right now
  // (claimed in the last 2 minutes). A claim older than that with no voucher means an earlier
  // attempt was cut off before finishing, so this delivery completes it instead of giving up -
  // otherwise a paid-for voucher could silently never be made.
  if (already && (already.code || (already.at && Date.now() - new Date(already.at).getTime() < 2 * 60 * 1000))) return;
  await index.set(sess.id, JSON.stringify({ mark: mark, at: new Date().toISOString() }));
  await new Promise(resolve => setTimeout(resolve, 250));
  const back = await index.get(sess.id, { type: 'json' });
  if (back && back.mark !== mark) return; // another delivery of the same payment got there first
  // The earlier attempt may have saved the voucher just before being cut off: never make a second one.
  try {
    const existingVouchers = await voucherHelpers.listVouchers();
    const found = existingVouchers.find(v => v.sessionId === sess.id);
    if (found) { await index.set(sess.id, JSON.stringify({ mark: mark, code: found.code, at: new Date().toISOString() })); return; }
  } catch (e) {}

  const vouchers = voucherHelpers.vouchersStore();
  let code = null;
  for (let i = 0; i < 6; i++) {
    const candidate = voucherHelpers.generateCode();
    if (!(await vouchers.get(candidate, { type: 'json' }))) { code = candidate; break; }
  }
  if (!code) {
    await sendEmail(JAMES_EMAIL, 'ACTION NEEDED: could not make a gift voucher', '<p>A gift voucher payment succeeded but a code could not be generated. Checkout session: ' + escapeHtml(sess.id) + '. Buyer: ' + escapeHtml(meta.buyerEmail || '') + '.</p>');
    return;
  }
  const nowMs = Date.now();
  const voucher = {
    code: code,
    status: 'active',
    lessonsTotal: lessonCount,
    durationMinutes: durationMinutes,
    pricePaidCents: sess.amount_total,
    buyerName: meta.buyerName || '',
    buyerEmail: (meta.buyerEmail || '').toLowerCase(),
    recipientName: meta.recipientName || '',
    message: meta.message || '',
    purchasedAt: new Date(nowMs).toISOString(),
    expiresAt: voucherHelpers.expiryDateFrom(nowMs),
    paymentIntentId: typeof sess.payment_intent === 'string' ? sess.payment_intent : null,
    sessionId: sess.id,
    redemptions: []
  };
  await voucherHelpers.saveVoucher(voucher);
  await index.set(sess.id, JSON.stringify({ mark: mark, code: code, at: new Date().toISOString() }));

  // The buyer gets the voucher itself (printable, right in the email); James gets the sale details.
  const buyerMail = emailTemplate.giftVoucherEmail(voucher);
  await sendEmail(voucher.buyerEmail, buyerMail.subject, buyerMail.html, buyerMail.text);
  const jamesMail = emailTemplate.giftSoldEmailForJames(voucher);
  await sendEmail(JAMES_EMAIL, jamesMail.subject, jamesMail.html, jamesMail.text);
}

// Used by the gift-voucher-reconcile job as well, which is safe: making a voucher for a payment that already has one does nothing.
exports.handleGiftPurchase = handleGiftPurchase;

async function claimFirstSetup(subscriptionId) {
  try {
    const locks = getStore({ name: 'subscription-setup-locks', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
    const existing = await locks.get(subscriptionId, { type: 'json' });
    if (existing && existing.at && Date.now() - new Date(existing.at).getTime() < 5 * 60 * 1000) return false;
    const mark = require('crypto').randomBytes(8).toString('hex');
    await locks.set(subscriptionId, JSON.stringify({ mark: mark, at: new Date().toISOString() }));
    const back = await locks.get(subscriptionId, { type: 'json' });
    return !back || back.mark === mark;
  } catch (e) {
    return true; // can't check: setting up twice is better than never
  }
}

function validBillingDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str || '') && !isNaN(new Date(str + 'T00:00:00').getTime());
}

function validStartDate(str, dow) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return null;
  const d = new Date(str + 'T00:00:00');
  if (isNaN(d.getTime()) || d.getDay() !== dow) return null;
  const daysAway = (d.getTime() - Date.now()) / 86400000;
  if (daysAway < 0 || daysAway > 200) return null;
  return str;
}

exports.handler = async function (event) {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return { statusCode: 400, body: 'Webhook signature verification failed' };
  }

  try {
    // Enrollments where the first payment is taken a few days before the
    // first lesson (see create-subscription.js) start with nothing to pay,
    // so there is no real payment to react to at sign-up. Their set-up is
    // triggered by checkout.session.completed instead, which treats it
    // exactly like a first invoice. Setting up is safe to trigger from
    // either event (or both): once a record exists, repeats are ignored.
    let synthesizedFirst = null;
    if (stripeEvent.type === 'checkout.session.completed') {
      const sess = stripeEvent.data.object;
      if (sess && sess.metadata && sess.metadata.mcq_gift === '1') {
        try {
          await handleGiftPurchase(sess);
        } catch (giftErr) {
          // This function deliberately answers Stripe with "ok" even on errors (see the end of
          // this file), so Stripe will NOT try again by itself. A buyer who has paid and has no
          // voucher is the one failure that must never go unnoticed, so say so loudly. The
          // 15-minute gift-voucher-reconcile job will also try again on its own.
          console.error('[stripe-webhook] gift voucher could not be made for', sess.id, ':', giftErr && giftErr.message ? giftErr.message : giftErr);
          const m = sess.metadata || {};
          await sendEmail(JAMES_EMAIL, 'ACTION NEEDED: a gift voucher was paid for but could not be made',
            '<p><strong>' + escapeHtml(m.buyerName || 'A buyer') + '</strong> (' + escapeHtml(m.buyerEmail || '') + ') paid for a gift voucher (' + escapeHtml(m.lessonCount || '?') + ' x ' + escapeHtml(m.durationMinutes || '?') + ' min), but the voucher could not be made just now. Checkout session: ' + escapeHtml(sess.id) + '.</p>' +
            '<p>The system will try again by itself within about 15 minutes, and you will get the usual "Gift voucher sold" email when it works. If you have not had that after half an hour, make the voucher by hand on your admin page (Gift vouchers section).</p>');
        }
      }
      if (sess && sess.mode === 'subscription' && sess.subscription && sess.metadata && sess.metadata.mcq_first_payment === 'later') {
        synthesizedFirst = { id: 'cs_' + sess.id, subscription: sess.subscription, billing_reason: 'subscription_create', amount_paid: 0, payment_intent: null };
      }
    }

    if (stripeEvent.type === 'invoice.payment_succeeded' || synthesizedFirst) {
      const invoice = synthesizedFirst || stripeEvent.data.object;
      const subscriptionId = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
      if (!subscriptionId) return { statusCode: 200, body: 'ok' };

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const meta = subscription.metadata || {};
      const firstPaymentLater = meta.firstPayment === 'later';
      let record = await getSubscriptionRecord(subscriptionId);
      // Normally the first invoice. A 'pay later' enrollment whose set-up
      // somehow hasn't happened yet is also set up when its first real
      // payment arrives - late is far better than never.
      const isFirstInvoice = invoice.billing_reason === 'subscription_create' || (firstPaymentLater && !record);

      // Already set up (the same sign-up reported by more than one event,
      // or Stripe repeating one): nothing more to do - without this a
      // repeat would book the lesson and send the emails a second time.
      if (isFirstInvoice && record) return { statusCode: 200, body: 'ok' };
      // Two events can report the same sign-up within milliseconds of each
      // other, both before either has written the record - only the first
      // one to claim it sets things up.
      if (isFirstInvoice && !(await claimFirstSetup(subscriptionId))) return { statusCode: 200, body: 'ok' };

      if (isFirstInvoice) {
        // First payment just succeeded via Checkout. Do one final
        // conflict check before locking in the slot, protects against
        // two students completing checkout for the same free slot at
        // almost the same time. Checks both other subscribers (day-of-
        // week based, they'd block every future occurrence) AND one-off
        // bookings on this specific upcoming date (a one-off booking
        // could have been made through the normal form at any point
        // during this checkout, before any subscription record existed
        // yet to block it).
        //
        // The check above this comment (freeFromOtherSubs/freeFromOneOffs)
        // is a "check, then write" pattern - not atomic on its own. If
        // two people finish Checkout for the exact same slot within
        // moments of each other, both webhooks could run that check
        // before either has actually written a subscription record,
        // both would see the slot as free, both would pass. The atomic
        // claim below closes that specific race the same way
        // reserve-multi-slots.js already does for one-off bookings:
        // whoever's onlyIfNew write actually lands first on this exact
        // day+time wins, the other is treated as a conflict, no matter
        // how close together they arrive. This only atomically covers
        // an EXACT day+time match, not every possible partial-overlap
        // combination (a true overlap-aware atomic lock would need to
        // claim a range, not a single key) - but an identical time is
        // the realistic race here, since the site only ever advertises
        // specific exact times as available, not a continuous range.
        const dow = parseInt(meta.dayOfWeek, 10);
        const slotClaimStore = getStore({ name: 'subscription-slot-claims', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
        const slotClaimKey = dow + '_' + meta.time;
        const CLAIM_STALE_MINUTES = 10; // generous window for genuine checkout/webhook timing, but this claim is never meant to be a permanent ownership record - listBlockingSubscriptionsForDay is what actually tracks that, correctly, for as long as the real subscription exists
        let claimedSlot = true;
        try {
          const claimResult = await slotClaimStore.set(slotClaimKey, JSON.stringify({ subscriptionId: subscriptionId, claimedAt: new Date().toISOString() }), { onlyIfNew: true });
          if (claimResult && claimResult.modified === false) {
            // Someone already holds this claim. Three possibilities:
            // (a) it's genuinely someone else racing for this exact slot
            // right now - a real conflict; (b) it's Stripe retrying OUR
            // OWN earlier successful webhook delivery - not a conflict;
            // (c) it's a leftover claim from a subscription that was
            // created here and has SINCE been cancelled (this store is
            // never cleaned up on cancellation) - without a staleness
            // check, that old claim would permanently block every
            // future subscriber to this slot, even once it's genuinely
            // free again. Only (a) is treated as an actual conflict.
            const existingClaim = await slotClaimStore.get(slotClaimKey, { type: 'json' });
            const isOwnRetry = !!(existingClaim && existingClaim.subscriptionId === subscriptionId);
            let isStaleClaim = false;
            if (!isOwnRetry && existingClaim && existingClaim.claimedAt) {
              const ageMinutes = (Date.now() - new Date(existingClaim.claimedAt).getTime()) / 60000;
              isStaleClaim = ageMinutes > CLAIM_STALE_MINUTES;
            }
            if (isStaleClaim) {
              await slotClaimStore.set(slotClaimKey, JSON.stringify({ subscriptionId: subscriptionId, claimedAt: new Date().toISOString() }));
            }
            claimedSlot = isOwnRetry || isStaleClaim;
          }
        } catch (claimErr) {
          console.error('[stripe-webhook] slot claim check failed:', claimErr && claimErr.message ? claimErr.message : claimErr);
        }
        // The first lesson date chosen when checkout was created (it can be
        // later than the usual one if single lessons were in the way);
        // falls back to working it out afresh if it is missing or no
        // longer sensible, e.g. checkout was left open for a long time.
        const lessonDate = validStartDate(meta.startDate, dow) || nextOccurrenceDate(dow, meta.time, MIN_NOTICE_HOURS, null);
        const freeFromOtherSubs = claimedSlot && await slotStillFree(dow, meta.time, meta.durationMinutes, subscriptionId);
        const freeFromOneOffs = claimedSlot && (lessonDate ? !(await oneOffBookingConflict(lessonDate, meta.time, meta.durationMinutes)) : true);
        if (!claimedSlot || !freeFromOtherSubs || !freeFromOneOffs) {
          console.error('[stripe-webhook] slot taken between checkout and payment for sub ' + subscriptionId + ', refunding and cancelling.');
          try {
            // Newer Stripe API versions no longer put payment_intent on the
            // invoice in the event itself (this account's webhook is on
            // one), so look the invoice up if it isn't there - otherwise a
            // real payment would never actually be refunded here.
            let refundPi = invoice.payment_intent;
            if (!refundPi && (invoice.amount_paid || 0) > 0 && invoice.id) {
              const fullInvoice = await stripe.invoices.retrieve(invoice.id);
              refundPi = fullInvoice && fullInvoice.payment_intent;
            }
            if (refundPi) await stripe.refunds.create({ payment_intent: refundPi });
            else if ((invoice.amount_paid || 0) > 0) console.error('[stripe-webhook] could not find the payment to refund for invoice', invoice.id, '- refund manually in Stripe');
          } catch (refundErr) {
            console.error('[stripe-webhook] refund failed:', refundErr && refundErr.message ? refundErr.message : refundErr);
          }
          try {
            await stripe.subscriptions.cancel(subscriptionId);
          } catch (cancelErr) {}
          await sendEmail(
            meta.studentEmail,
            'MCQ Music Lessons: enrollment could not be started',
            '<p>Hi ' + escapeHtml(meta.studentName) + ',</p><p>Sorry, that lesson slot was taken by another student in the moments before your payment went through. You have been fully refunded, no charge will appear on your account. Please head back to the booking page to choose a different time.</p><p>James</p>'
          );
          return { statusCode: 200, body: 'ok' };
        }

        // Inherits any pause-week usage this email has already used this
        // year - either from pausing an earlier subscription, or from
        // resubscribing soon after a previous one ended (see
        // RESUBSCRIBE_GAP_DAYS in subscription-helpers.js) - so
        // cancelling and starting fresh can't be used to dodge the same
        // 4-week/year cap pausing is deliberately capped at.
        const emailHistory = await getEmailHistory(meta.studentEmail);
        const inheritedWeeks = inheritedPauseWeeksForNewSubscription(emailHistory);

        record = {
          subscriptionId: subscriptionId,
          studentName: meta.studentName,
          studentEmail: meta.studentEmail,
          instrument: meta.instrument,
          guitarType: meta.guitarType || '',
          dayOfWeek: meta.dayOfWeek,
          time: meta.time,
          durationMinutes: meta.durationMinutes,
          frequency: meta.frequency,
          skillLevel: meta.skillLevel || '',
          songRequests: meta.songRequests || '',
          genreFocus: meta.genreFocus || '',
          theoryInterest: meta.theoryInterest || '',
          goalsNotes: meta.goalsNotes || '',
          status: 'active',
          pausedWeeksThisYear: inheritedWeeks,
          pauseYear: currentYear(),
          createdAt: new Date().toISOString()
        };
        // Set only while the first payment is still to come, so that payment
        // (which is for the lesson booked just below) doesn't also book the
        // NEXT lesson. Every payment after it books the next lesson as usual.
        if (firstPaymentLater && (invoice.amount_paid || 0) === 0) record.firstPaymentPending = true;
        // Lets one-off bookings use this slot on dates BEFORE the enrollment
        // actually starts (see reserve-multi-slots.js).
        if (lessonDate) record.startDate = lessonDate;
        await saveSubscriptionRecord(subscriptionId, record);

        if (lessonDate) {
          record.nextLessonDate = lessonDate;
          await saveSubscriptionRecord(subscriptionId, record);
          await createLessonOccurrence(lessonDate, record);
        }

        const price = PRICE_BY_DURATION[String(meta.durationMinutes)];
        const safeMetaInstrument = escapeHtml(meta.instrument);
        const safeMetaGuitarType = escapeHtml(meta.guitarType);
        const displayInstrument = (safeMetaGuitarType && safeMetaGuitarType !== 'Either' && meta.instrument !== 'Piano')
          ? safeMetaInstrument + ' (' + safeMetaGuitarType + ')'
          : safeMetaInstrument;
        const gcalLink = lessonDate ? buildGoogleCalendarLink((meta.instrument || 'Music') + ' Lesson - MCQ Music', lessonDate, meta.time, meta.durationMinutes, meta.frequency) : null;
        const gcalLinkHtml = gcalLink ? '<p><a href="' + gcalLink + '">Add to Google Calendar</a> (repeats automatically)</p>' : '';
        await sendEmail(
          meta.studentEmail,
          'MCQ Music Lessons: your ' + meta.frequency + ' enrollment is confirmed',
          '<p>Hi ' + escapeHtml(meta.studentName) + ',</p><p>Welcome to your ' + meta.frequency + ' lessons with MCQ Music!</p><p>Your ' + meta.frequency + ' ' + meta.durationMinutes + ' minute ' + displayInstrument + ' lesson enrollment is confirmed for ' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow] + 's at ' + meta.time + (price ? ', $' + price + ' per lesson' : '') + '. Your next lesson is ' + formatFriendlyDate(lessonDate) + '.</p>' + (meta.billingStartDate && validBillingDate(meta.billingStartDate) ? (firstPaymentLater && record.firstPaymentPending ? '<p>You have not been charged yet. Your first payment will be taken on ' + formatFriendlyDate(meta.billingStartDate) + ', and after that a few days before each lesson.</p>' : '<p>Your first lesson has been paid for. Your next payment will be taken on ' + formatFriendlyDate(meta.billingStartDate) + ', and after that a few days before each lesson.</p>') : '') + '<p>Lessons are at 84 Nelson Rd, South Melbourne VIC 3205.</p>' + gcalLinkHtml + '<p>Can\'t make a particular lesson? With 24+ hours\' notice you can reschedule just that one from <a href="https://mcqmusiclessons.com.au/booking.html#manage">My Lessons</a>, no need to touch your enrollment. For a longer break, you can pause (up to 8 weeks a year) or cancel any time from your <a href="https://mcqmusiclessons.com.au/booking.html#manage-subscription">Manage Enrollment</a> page.</p><p style="font-size:0.85em;color:#666;">Feeling unwell with cold or flu-like symptoms? Please reschedule rather than attending in person.</p><p>James</p>'
        );
        await sendEmail(
          JAMES_EMAIL,
          'New enrollment: ' + meta.studentName,
          '<p>' + escapeHtml(meta.studentName) + ' (' + escapeHtml(meta.studentEmail) + ') just enrolled: ' + displayInstrument + ', ' + meta.frequency + ' ' + meta.durationMinutes + ' min, ' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow] + 's at ' + meta.time + '. Next lesson: ' + formatFriendlyDate(lessonDate) + '.</p>' +
          (meta.skillLevel ? '<p><strong>Skill level:</strong> ' + escapeHtml(meta.skillLevel) + '</p>' : '') +
          (meta.songRequests ? '<p><strong>Songs/artists:</strong> ' + escapeHtml(meta.songRequests) + '</p>' : '') +
          (meta.genreFocus ? '<p><strong>Genre focus:</strong> ' + escapeHtml(meta.genreFocus) + '</p>' : '') +
          (meta.theoryInterest === 'Yes' ? '<p>Wants music theory included</p>' : '') +
          (meta.theoryInterest === 'Not sure' ? '<p>Not sure about music theory - worth asking</p>' : '') +
          (meta.goalsNotes ? '<p><strong>Notes:</strong> ' + escapeHtml(meta.goalsNotes) + '</p>' : '')
        );
      } else if (record) {
        // Renewal invoice, advance to the next lesson occurrence and
        // create its booking + calendar event.
        //
        // A renewal invoice.payment_succeeded firing at all is itself
        // conclusive proof the pause has ended - Stripe's pause_collection
        // (behavior: 'void') would never let an invoice succeed while a
        // pause is still active. pause-expiry-check.js syncs our own
        // record.status back to 'active' once daily, but that sync and
        // Stripe's own resumes_at moment aren't perfectly in lockstep, so
        // a renewal can succeed slightly before that day's sync has run.
        // Trusting the event itself (rather than only trusting our
        // possibly-stale status field) and self-healing here means a paid
        // renewal can never silently fail to get booked just because the
        // daily sync hadn't caught up yet.
        if (record.status === 'paused') {
          console.log('[stripe-webhook] renewal succeeded while record still showed paused for ' + subscriptionId + ', self-healing status to active');
          record.status = 'active';
          delete record.pausedUntil;
        } else if (record.status !== 'active') {
          return { statusCode: 200, body: 'ok' };
        }
        // A successful renewal means any earlier payment issue has
        // resolved itself (a Stripe retry succeeded) - clear the
        // grace-period tracking so it doesn't carry over to a future,
        // unrelated failure. Harmless no-op if neither was set.
        record.paymentFailedAt = null;
        record.paymentFailureReminderSent = false;
        // The first payment of a 'pay later' enrollment: it pays for the
        // lesson that was booked at sign-up, so there is no next lesson to
        // book yet - only the payment itself to record.
        if (record.firstPaymentPending) {
          delete record.firstPaymentPending;
          await saveSubscriptionRecord(subscriptionId, record);
          return { statusCode: 200, body: 'ok' };
        }
        // Uses nextRenewalDate (one full billing interval - 7 or 14
        // days depending on frequency - after the previous lesson),
        // not nextOccurrenceDate (which would always land 7 days later
        // regardless of frequency, silently turning fortnightly
        // subscriptions into weekly ones). Falls back to
        // nextOccurrenceDate only if nextLessonDate is somehow missing.
        const dow = parseInt(record.dayOfWeek, 10);
        const lessonDate = record.nextLessonDate
          ? nextRenewalDate(record.nextLessonDate, record.frequency)
          : nextOccurrenceDate(dow, record.time, 0, null);
        if (lessonDate) {
          record.nextLessonDate = lessonDate;
          await saveSubscriptionRecord(subscriptionId, record);
          await createLessonOccurrence(lessonDate, record);
        }
      }
    }

    if (stripeEvent.type === 'invoice.payment_failed') {
      const invoice = stripeEvent.data.object;
      const subscriptionId = invoice.subscription;
      if (subscriptionId) {
        const record = await getSubscriptionRecord(subscriptionId);
        // Only act on the FIRST failure in a cycle. Stripe's Smart
        // Retries fire this same event again on each subsequent retry
        // attempt (typically several times over ~1-2 weeks) - without
        // this guard, every retry would reset the grace-period clock
        // (subscription-payment-grace-check.js reads paymentFailedAt)
        // and re-send this email each time, which is both spammy and
        // would mean the slot never actually gets released on schedule.
        if (record && !record.paymentFailedAt) {
          record.paymentFailedAt = new Date().toISOString();
          await saveSubscriptionRecord(subscriptionId, record);

          await sendEmail(
            record.studentEmail,
            'MCQ Music Lessons: payment issue with your enrollment',
            '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>We could not process your latest enrollment payment. Stripe will automatically retry over the next few days. Please make sure your card details are up to date. If this isn\'t resolved within ' + PAYMENT_GRACE_PERIOD_DAYS + ' days, your slot will be automatically released so it doesn\'t sit unused. You can check or update your enrollment from your <a href="https://mcqmusiclessons.com.au/booking.html#manage-subscription">Manage Enrollment</a> page.</p><p>James</p>'
          );
          await sendEmail(
            JAMES_EMAIL,
            'Payment failed: ' + record.studentName,
            '<p>' + escapeHtml(record.studentName) + '\'s enrollment payment failed. Stripe will retry automatically. If it isn\'t resolved within ' + PAYMENT_GRACE_PERIOD_DAYS + ' days, their slot will be automatically released and you\'ll get a separate email confirming it.</p>'
          );
        }
      }
    }

    if (stripeEvent.type === 'payment_intent.succeeded') {
      await handleLessonPaymentSucceeded(stripeEvent.data.object);
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const subscription = stripeEvent.data.object;
      const subscriptionId = subscription.id;
      const record = await getSubscriptionRecord(subscriptionId);
      if (record) {
        await deleteSubscriptionRecord(subscriptionId);

        // Persists this student's pause-week usage and end date at the
        // email level so it survives this subscription record being
        // deleted - needed so a new subscription created soon after
        // correctly inherits it instead of resetting to a clean slate
        // every time someone cancels and restarts.
        if (record.studentEmail) {
          const existingHistory = await getEmailHistory(record.studentEmail);
          const historyStillCurrent = existingHistory && existingHistory.pauseYear === currentYear();
          const emailWeeksSoFar = historyStillCurrent ? (existingHistory.pausedWeeksThisYear || 0) : 0;
          const emailSummerWeeksSoFar = historyStillCurrent ? (existingHistory.summerWeeksUsed || 0) : 0;
          const subscriptionWeeks = pausedWeeksThisYear(record);
          const subscriptionSummerWeeks = summerWeeksUsed(record);
          await saveEmailHistory(record.studentEmail, {
            pausedWeeksThisYear: Math.max(emailWeeksSoFar, subscriptionWeeks),
            summerWeeksUsed: Math.max(emailSummerWeeksSoFar, subscriptionSummerWeeks),
            pauseYear: currentYear(),
            lastEndedAt: new Date().toISOString().slice(0, 10)
          });
        }

        await sendEmail(
          record.studentEmail,
          'MCQ Music Lessons: enrollment ended',
          '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>Your weekly lesson enrollment has now ended and your slot has been released. You are welcome to <a href="https://mcqmusiclessons.com.au/booking.html#calendar">enroll again</a> any time.</p><p>James</p>'
        );
        await sendEmail(
          JAMES_EMAIL,
          'Enrollment ended: ' + record.studentName,
          '<p>' + escapeHtml(record.studentName) + '\'s enrollment has ended. Their slot (' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][parseInt(record.dayOfWeek,10)] + 's ' + record.time + ') is now free.</p>'
        );
      }
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err && err.message ? err.message : err);
    // Return 200 anyway so Stripe doesn't retry-storm on a bug in our
    // own email/logging code after the core action already succeeded;
    // genuine failures are visible in Netlify function logs.
    return { statusCode: 200, body: 'ok' };
  }
};
