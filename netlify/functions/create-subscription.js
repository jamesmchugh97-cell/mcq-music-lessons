// create-subscription.js
// Netlify serverless function: starts a recurring weekly/fortnightly
// lesson subscription for a student. Checks the requested day/time/
// duration doesn't clash with an existing recurring student or an
// upcoming one-off booking, then creates a Stripe Checkout Session in
// subscription mode. The actual booking + calendar event for each lesson
// is created later by stripe-webhook.js when Stripe confirms payment
// (invoice.payment_succeeded), this function only starts the
// subscription and never writes a booking record itself.
const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');
const { getEmailHistory, inheritedPauseWeeksForNewSubscription, RESUBSCRIBE_GAP_DAYS, MAX_PAUSE_WEEKS_PER_YEAR, PRICE_IDS, listBlockingSubscriptionsForDay, isStalePendingHold } = require('./subscription-helpers');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const MIN_GAP_MINUTES = 30;

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

const FRI_SAT_CLOSING_MINUTES = 16 * 60 + 30;
const MON_THU_CLOSING_MINUTES = 21 * 60;

// Checks business hours directly off the day-of-week integer (0=Sun,
// 1=Mon..6=Sat) rather than reconstructing a fake calendar date just to
// read its weekday back off it. The previous version used a
// placeholderDates[] array indexed 0-5 against a dow range of 0-6, which
// was off by one: Thursday (dow=4) read Friday's date and got checked
// against the earlier 4:30pm Fri/Sat closing instead of the correct
// 9pm Mon-Thu closing, wrongly rejecting most real Thursday evening
// requests; Saturday (dow=6) fell through to the "|| placeholderDates[1]"
// fallback (Tuesday) and got checked against the later 9pm closing
// instead of the correct 4:30pm, wrongly allowing times that should
// have been blocked. This version can't drift the same way since it
// never touches a date at all.
function isWithinBusinessHoursForDow(dow, startMinutes, endMinutes) {
  if (dow === 5 || dow === 6) return endMinutes <= FRI_SAT_CLOSING_MINUTES;
  if (dow === 0) return false; // Sunday closed
  return endMinutes <= MON_THU_CLOSING_MINUTES;
}

// Same hardcoded roster used by reserve-multi-slots.js. Kept in sync
// manually, after a new subscription is confirmed, James still needs
// to add the student here (and in reserve-multi-slots.js /
// redeem-reschedule-credit.js) so future one-off bookings can't land on
// top of their slot.
const RECURRING_STUDENTS = [
  { name: 'Meja',    dow: 1, time: '4:00 pm', duration: 75 },
  { name: 'Nick',    dow: 1, time: '6:00 pm', duration: 90 },
  { name: 'Jacq',    dow: 2, time: '2:30 pm', duration: 60 },
  { name: 'Cash',    dow: 2, time: '4:45 pm', duration: 45 },
  { name: 'Angus',   dow: 2, time: '5:30 pm', duration: 30 },
  { name: 'Maria',   dow: 2, time: '6:00 pm', duration: 60 },
  { name: 'Emma',    dow: 2, time: '7:15 pm', duration: 60 },
  { name: 'Tilly',   dow: 2, time: '8:15 pm', duration: 60 },
  { name: 'Michael', dow: 3, time: '1:00 pm', duration: 60 },
  { name: 'Jacq',    dow: 3, time: '2:00 pm', duration: 90 },
  { name: 'Hugo',    dow: 3, time: '3:45 pm', duration: 45 },
  { name: 'Anya',    dow: 3, time: '5:15 pm', duration: 30 },
  { name: 'Alex',    dow: 3, time: '6:00 pm', duration: 60 },
  { name: 'Shannon', dow: 3, time: '7:15 pm', duration: 60 },
  { name: 'Cash',    dow: 4, time: '3:45 pm', duration: 45 },
  { name: 'Meja',    dow: 4, time: '4:30 pm', duration: 75 },
  { name: 'Odie',    dow: 4, time: '6:15 pm', duration: 30 },
  { name: 'Javin',   dow: 4, time: '6:45 pm', duration: 60 }
];

function conflictsWithRoster(dow, startMinutes, endMinutes) {
  return RECURRING_STUDENTS.some(s => {
    if (s.dow !== dow) return false;
    const sStart = timeToMinutes(s.time);
    const sEnd = sStart + s.duration;
    const overlap = startMinutes < sEnd && sStart < endMinutes;
    if (!overlap) return false;
    return true;
  });
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

  const { studentName, studentEmail, instrument, guitarType, dayOfWeek: dow, time, durationMinutes, frequency, skillLevel, songRequests, genreFocus, theoryInterest, goalsNotes } = body;

  if (!studentName || !studentEmail || !instrument || dow === undefined || !time || !durationMinutes || !frequency || !skillLevel) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing required subscription details.' }) };
  }
  if (frequency !== 'weekly' && frequency !== 'fortnightly') {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Frequency must be weekly or fortnightly.' }) };
  }

  // Only blocks the specific case of someone who has ALREADY used their
  // full annual pause-week allowance (via pausing, cancel-then-resubscribe
  // cycling, or a mix) trying to cycle again within the same short
  // window - not every cancellation, which would unfairly punish anyone
  // with a genuine one-off reason to cancel and later come back sooner
  // than the gap window. Checked here (before Stripe Checkout even
  // starts) so nobody's charged only to be told no afterwards.
  const emailHistory = await getEmailHistory(studentEmail);
  const wouldInherit = inheritedPauseWeeksForNewSubscription(emailHistory);
  if (wouldInherit > MAX_PAUSE_WEEKS_PER_YEAR && emailHistory && emailHistory.lastEndedAt) {
    const daysSinceEnded = Math.floor((Date.now() - new Date(emailHistory.lastEndedAt + 'T00:00:00').getTime()) / 86400000);
    if (daysSinceEnded >= 0 && daysSinceEnded <= RESUBSCRIBE_GAP_DAYS) {
      const availableAgainDate = new Date(emailHistory.lastEndedAt + 'T00:00:00');
      availableAgainDate.setDate(availableAgainDate.getDate() + RESUBSCRIBE_GAP_DAYS + 1);
      const availableAgainStr = availableAgainDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "You've already used your " + MAX_PAUSE_WEEKS_PER_YEAR + ' weeks of flexibility for this year. You\'re welcome to subscribe again from ' + availableAgainStr + ', or book lessons one at a time in the meantime.' })
      };
    }
  }

  const priceKey = String(durationMinutes) + '_' + frequency;
  const priceId = PRICE_IDS[priceKey];
  if (!priceId) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'No price found for that duration and frequency.' }) };
  }

  const startMinutes = timeToMinutes(time);
  if (startMinutes === null) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid time format.' }) };
  }
  const endMinutes = startMinutes + parseInt(durationMinutes, 10);

  if (!isWithinBusinessHoursForDow(dow, startMinutes, endMinutes)) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time falls outside business hours for that day.' }) };
  }

  if (conflictsWithRoster(dow, startMinutes, endMinutes)) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That slot is already taken by another regular student. Please choose a different day or time.' }) };
  }

  // Checks OTHER subscribers on this day, including paused ones - not
  // just active. A paused subscriber's slot is deliberately left free
  // for one-off bookings (that's the whole point of pausing), but a
  // NEW SUBSCRIPTION is a different thing: it would try to claim that
  // slot permanently, directly colliding with the paused student's own
  // return. So this is the one place a paused subscription still
  // counts as blocking. The specific wording below only applies when
  // the conflict is with a paused subscriber, so someone gets a clear
  // reason rather than a generic "already taken".
  const otherSubs = await listBlockingSubscriptionsForDay(dow, null, ['active', 'paused']);
  const conflictingSub = otherSubs.find(s => {
    const sStart = timeToMinutes(s.time);
    const sEnd = sStart + parseInt(s.durationMinutes, 10);
    return startMinutes < sEnd && sStart < endMinutes;
  });
  if (conflictingSub) {
    if (conflictingSub.status === 'paused') {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: "This time is free for single lessons right now, but it's reserved for a returning subscriber, so it's not available to subscribe to. You're welcome to book a one-off lesson there, or subscribe to a different time." }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That slot is already taken by another subscriber. Please choose a different day or time.' }) };
  }

  // Also check upcoming one-off Blobs bookings on that weekday, however
  // far out they go, so a subscription can't be started on top of a
  // slot someone already booked as a single lesson. One full scan of
  // the store rather than looping day-by-day: a multi-lesson one-off
  // booking has no fixed cap on how far out it can legitimately reach
  // (weekly has none at all, fortnightly's own 5-lesson cap alone
  // reaches 56 days out), so any fixed number of weeks here would
  // eventually miss something rather than just being slower.
  try {
    const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
    const todayStr = new Date().toISOString().slice(0, 10);
    const { blobs } = await store.list();
    for (const blob of blobs) {
      const dateStr = blob.key.split('_')[0];
      if (!dateStr || dateStr < todayStr) continue;
      const d = new Date(dateStr + 'T00:00:00');
      if (isNaN(d.getTime()) || d.getDay() !== dow) continue;
      const record = await store.get(blob.key, { type: 'json' });
      if (!record || !record.time || isStalePendingHold(record)) continue;
      const exStart = timeToMinutes(record.time);
      const exEnd = exStart + (record.duration || 45);
      const overlap = startMinutes < exEnd && exStart < endMinutes;
      if (overlap) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That slot is already booked on ' + dateStr + '. Please choose a different day or time.' }) };
      }
    }
  } catch (checkErr) {
    console.error('[create-subscription] conflict check failed:', checkErr && checkErr.message ? checkErr.message : checkErr);
  }

  // ===== RECONSTRUCTED FROM HERE DOWN =====
  // Everything above this point is exactly what was pasted in. Below is
  // rebuilt to match what stripe-webhook.js reads back off
  // subscription.metadata (studentName, studentEmail, instrument,
  // dayOfWeek, time, durationMinutes, frequency - confirmed by reading
  // stripe-webhook.js directly), plus the success/cancel redirect
  // Stripe requires for a hosted Checkout Session. The redirect URLs
  // are a best guess (back to the Subscribe section either way) - if
  // your live version already sends students somewhere specific after
  // paying, let me know and I'll match it exactly.
  try {
    const siteUrl = process.env.URL || 'https://mcqmusiclessons.com.au';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: studentEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: {
          studentName: studentName,
          studentEmail: studentEmail,
          instrument: instrument,
          guitarType: (guitarType && instrument !== 'Piano') ? guitarType : '',
          dayOfWeek: String(dow),
          time: time,
          durationMinutes: String(durationMinutes),
          frequency: frequency,
          skillLevel: skillLevel,
          // Truncated defensively - Stripe rejects any metadata value
          // over 500 characters outright, which would fail the whole
          // subscription creation with a confusing error rather than
          // just losing a bit of the notes. The booking page's own
          // maxlength attributes are the primary defense; this is the
          // backstop for anyone calling this endpoint directly.
          songRequests: (songRequests || '').slice(0, 300),
          genreFocus: (genreFocus || '').slice(0, 200),
          theoryInterest: theoryInterest || '',
          goalsNotes: (goalsNotes || '').slice(0, 450)
        }
      },
      success_url: siteUrl + '/booking.html?subscribed=1#subscribe',
      cancel_url: siteUrl + '/booking.html#subscribe'
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, url: session.url })
    };
  } catch (stripeErr) {
    console.error('[create-subscription] Stripe checkout session creation failed:', stripeErr && stripeErr.message ? stripeErr.message : stripeErr);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: 'Could not start checkout. Please try again or contact James directly.' })
    };
  }
};
