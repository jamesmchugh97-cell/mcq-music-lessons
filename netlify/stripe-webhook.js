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

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const MIN_NOTICE_HOURS = 24;
// Mirrors the pricing tiers used everywhere else on the site, so
// subscription emails can quote the actual per-lesson price without
// needing a live Stripe lookup.
const PRICE_BY_DURATION = { '30': 50, '45': 70, '60': 85, '75': 100, '90': 130 };

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

function minutesToIsoClock(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00';
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

// Creates the booking record + Google Calendar event for one specific
// lesson occurrence (one billing cycle = one lesson), same shape as a
// normal one-off booking so it shows up correctly everywhere else in
// the system (Manage Booking, calendar, etc). Tags it with
// subscriptionId so it's identifiable as subscription-generated.
async function createLessonOccurrence(dateStr, record) {
  const store = bookingsStore();
  const key = dateStr + '_' + record.time;
  const bookingRecord = {
    date: dateStr,
    time: record.time,
    duration: parseInt(record.durationMinutes, 10),
    name: record.studentName,
    email: record.studentEmail,
    subscriptionId: record.subscriptionId,
    bookedAt: new Date().toISOString()
  };
  try {
    const result = await store.set(key, JSON.stringify(bookingRecord), { onlyIfNew: true });
    if (result && result.modified === false) {
      // Extremely rare: a one-off booking already exists on this exact
      // slot. Don't silently overwrite it, log loudly so James can
      // manually check, since automated slot checks should have
      // prevented this happening in the first place.
      console.error('[stripe-webhook] CONFLICT: lesson occurrence ' + key + ' already exists as a booking. Manual check needed.');
      return null;
    }
  } catch (e) {
    console.error('[stripe-webhook] failed to write lesson occurrence:', e && e.message ? e.message : e);
    return null;
  }

  try {
    const startMinutes = timeToMinutes(record.time);
    const endMinutes = startMinutes + parseInt(record.durationMinutes, 10);
    const startDateTime = dateStr + 'T' + minutesToIsoClock(startMinutes);
    const endDateTime = dateStr + 'T' + minutesToIsoClock(endMinutes);
    // Same "only show it if it actually narrows something down" rule
    // as the one-off booking flow - "Either / Both" isn't worth stating
    // since James needs both options ready regardless.
    const displayInstrument = (record.guitarType && record.guitarType !== 'Either' && record.instrument !== 'Piano')
      ? record.instrument + ' (' + record.guitarType + ')'
      : record.instrument;
    const eventId = await createCalendarEvent({
      studentName: record.studentName,
      startDateTime: startDateTime,
      endDateTime: endDateTime,
      notes: 'Weekly subscription lesson (' + record.frequency + '), ' + record.studentEmail,
      instrument: displayInstrument
    });
    if (eventId) {
      bookingRecord.eventId = eventId;
      await store.set(key, JSON.stringify(bookingRecord));
    }
  } catch (calErr) {
    console.error('[stripe-webhook] calendar event failed for ' + key + ':', calErr && calErr.message ? calErr.message : calErr);
  }

  return dateStr;
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
    if (stripeEvent.type === 'invoice.payment_succeeded') {
      const invoice = stripeEvent.data.object;
      const subscriptionId = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
      if (!subscriptionId) return { statusCode: 200, body: 'ok' };

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const meta = subscription.metadata || {};
      const isFirstInvoice = invoice.billing_reason === 'subscription_create';

      let record = await getSubscriptionRecord(subscriptionId);

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
        const lessonDate = nextOccurrenceDate(dow, meta.time, MIN_NOTICE_HOURS, null);
        const freeFromOtherSubs = claimedSlot && await slotStillFree(dow, meta.time, meta.durationMinutes, subscriptionId);
        const freeFromOneOffs = claimedSlot && (lessonDate ? !(await oneOffBookingConflict(lessonDate, meta.time, meta.durationMinutes)) : true);
        if (!claimedSlot || !freeFromOtherSubs || !freeFromOneOffs) {
          console.error('[stripe-webhook] slot taken between checkout and payment for sub ' + subscriptionId + ', refunding and cancelling.');
          try {
            await stripe.refunds.create({ payment_intent: invoice.payment_intent });
          } catch (refundErr) {
            console.error('[stripe-webhook] refund failed:', refundErr && refundErr.message ? refundErr.message : refundErr);
          }
          try {
            await stripe.subscriptions.cancel(subscriptionId);
          } catch (cancelErr) {}
          await sendEmail(
            meta.studentEmail,
            'MCQ Music Lessons: subscription could not be started',
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
          status: 'active',
          pausedWeeksThisYear: inheritedWeeks,
          pauseYear: currentYear(),
          createdAt: new Date().toISOString()
        };
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
          'MCQ Music Lessons: your ' + meta.frequency + ' subscription is confirmed',
          '<p>Hi ' + escapeHtml(meta.studentName) + ',</p><p>Welcome to your ' + meta.frequency + ' lessons with MCQ Music!</p><p>Your ' + meta.frequency + ' ' + meta.durationMinutes + ' minute ' + displayInstrument + ' lesson subscription is confirmed for ' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow] + 's at ' + meta.time + (price ? ', $' + price + ' per lesson' : '') + '. Your next lesson is ' + formatFriendlyDate(lessonDate) + '.</p><p>Lessons are at 84 Nelson Rd, South Melbourne VIC 3205.</p>' + gcalLinkHtml + '<p>Can\'t make a particular lesson? With 24+ hours\' notice you can reschedule just that one from <a href="https://mcqmusiclessons.com.au/booking.html#manage">Manage Booking</a>, no need to touch your subscription. For a longer break, you can pause (up to 4 weeks a year) or cancel any time from your <a href="https://mcqmusiclessons.com.au/booking.html#manage-subscription">Manage Subscription</a> page.</p><p>James</p>'
        );
        await sendEmail(
          JAMES_EMAIL,
          'New subscription: ' + meta.studentName,
          '<p>' + escapeHtml(meta.studentName) + ' (' + escapeHtml(meta.studentEmail) + ') just subscribed: ' + displayInstrument + ', ' + meta.frequency + ' ' + meta.durationMinutes + ' min, ' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow] + 's at ' + meta.time + '. Next lesson: ' + formatFriendlyDate(lessonDate) + '.</p>'
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
            'MCQ Music Lessons: payment issue with your subscription',
            '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>We could not process your latest subscription payment. Stripe will automatically retry over the next few days. Please make sure your card details are up to date. If this isn\'t resolved within ' + PAYMENT_GRACE_PERIOD_DAYS + ' days, your slot will be automatically released so it doesn\'t sit unused. You can check or update your subscription from your <a href="https://mcqmusiclessons.com.au/booking.html#manage-subscription">Manage Subscription</a> page.</p><p>James</p>'
          );
          await sendEmail(
            JAMES_EMAIL,
            'Payment failed: ' + record.studentName,
            '<p>' + escapeHtml(record.studentName) + '\'s subscription payment failed. Stripe will retry automatically. If it isn\'t resolved within ' + PAYMENT_GRACE_PERIOD_DAYS + ' days, their slot will be automatically released and you\'ll get a separate email confirming it.</p>'
          );
        }
      }
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
          'MCQ Music Lessons: subscription ended',
          '<p>Hi ' + escapeHtml(record.studentName) + ',</p><p>Your weekly lesson subscription has now ended and your slot has been released. You are welcome to <a href="https://mcqmusiclessons.com.au/booking.html#subscribe">subscribe again</a> any time.</p><p>James</p>'
        );
        await sendEmail(
          JAMES_EMAIL,
          'Subscription ended: ' + record.studentName,
          '<p>' + escapeHtml(record.studentName) + '\'s subscription has ended. Their slot (' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][parseInt(record.dayOfWeek,10)] + 's ' + record.time + ') is now free.</p>'
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
