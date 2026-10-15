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
const { nextOccurrenceDate, melbourneEpochMs, getEmailHistory, inheritedPauseWeeksForNewSubscription, RESUBSCRIBE_GAP_DAYS, MAX_PAUSE_WEEKS_PER_YEAR, PRICE_IDS, listBlockingSubscriptionsForDay, isStalePendingHold } = require('./subscription-helpers');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const MIN_GAP_MINUTES = 30;
const MIN_NOTICE_HOURS = 24;
// A weekly slot may start later than usual when single lessons already
// sit in it (see below), but not absurdly later: students pay for their
// first lesson up front, so anything further out than this is refused
// with a clear message rather than quietly taking their money for a
// lesson months away.
const MAX_START_DELAY_DAYS = 35;
// How far ahead a student may choose to start (the "Start from" week on the
// booking page).
const MAX_START_AHEAD_DAYS = 91; // 13 weeks - 3 months, same as lessons and packages

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

const FRI_CLOSING_MINUTES = 16 * 60 + 30;
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
  if (dow === 0 || dow === 6) return false; // Sunday and Saturday closed
  if (dow === 5) return endMinutes <= FRI_CLOSING_MINUTES;
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
  { name: 'Maria',   dow: 2, time: '6:00 pm', duration: 60 },
  { name: 'Emma',    dow: 2, time: '7:00 pm', duration: 60 },
  { name: 'Michael', dow: 3, time: '1:00 pm', duration: 60 },
  { name: 'Hugo',    dow: 3, time: '3:45 pm', duration: 45 },
  { name: 'Anya',    dow: 3, time: '5:15 pm', duration: 30 },
  { name: 'Alex',    dow: 3, time: '6:00 pm', duration: 60 },
  { name: 'Shannon', dow: 3, time: '7:15 pm', duration: 60 },
  { name: 'Meja',    dow: 4, time: '4:30 pm', duration: 75 },
  { name: 'Odie',    dow: 4, time: '5:45 pm', duration: 30 },
  { name: 'Will',     dow: 4, time: '6:15 pm', duration: 30 },
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

  const { studentName, studentEmail, instrument, guitarType, dayOfWeek: dow, time, durationMinutes, frequency, skillLevel, songRequests, genreFocus, theoryInterest, goalsNotes, startFrom } = body;

  if (!studentName || !studentEmail || !instrument || dow === undefined || !time || !durationMinutes || !frequency || !skillLevel) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing required enrollment details.' }) };
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
        body: JSON.stringify({ success: false, error: "You've already used your " + MAX_PAUSE_WEEKS_PER_YEAR + ' weeks of flexibility for this year. You\'re welcome to enroll again from ' + availableAgainStr + ', or book lessons one at a time in the meantime.' })
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
      return { statusCode: 200, body: JSON.stringify({ success: false, error: "This time is free for single lessons right now, but it's reserved for a returning student, so it's not available to enroll in. You're welcome to book a one-off lesson there, or enroll in a different time." }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That slot is already taken by another enrolled student. Please choose a different day or time.' }) };
  }

  // Single (one-off) lessons already booked at this weekday and time.
  // These used to block the enrollment outright - so a time could show
  // as free on the booking page and then be refused at the last step,
  // just because one person had a single lesson in that slot weeks away.
  // Now a single lesson only ever blocks the weeks it actually occupies:
  // the weekly slot simply starts the week AFTER the last single lesson
  // in it, and that student keeps their lesson. First come, first
  // served: whoever enrolls only gets the weeks nobody has booked.
  // One full scan of the store rather than looping day-by-day: a
  // multi-lesson one-off booking has no fixed cap on how far out it can
  // reach, so any fixed number of weeks here would eventually miss
  // something rather than just being slower.
  let startDate = null; // date of the first lesson, handed to the webhook below
  let normalFirst = null; // the first lesson date if no single lessons were in the way
  try {
    const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
    const todayStr = new Date().toISOString().slice(0, 10);
    const { blobs } = await store.list();
    const conflictDates = [];
    for (const blob of blobs) {
      const dateStr = blob.key.split('_')[0];
      if (!dateStr || dateStr < todayStr) continue;
      const d = new Date(dateStr + 'T00:00:00');
      if (isNaN(d.getTime()) || d.getDay() !== Number(dow)) continue;
      const record = await store.get(blob.key, { type: 'json' });
      if (!record || !record.time || isStalePendingHold(record)) continue;
      const exStart = timeToMinutes(record.time);
      const exEnd = exStart + (record.duration || 45);
      const overlap = startMinutes < exEnd && exStart < endMinutes;
      if (overlap) conflictDates.push(dateStr);
    }
    normalFirst = nextOccurrenceDate(Number(dow), time, MIN_NOTICE_HOURS, null);
    // A later start chosen by the student ("Start from" week on the booking
    // page): the first lesson is the first matching weekday on or after that
    // date. From here on, normalFirst simply means "the earliest this
    // enrollment is allowed to start", so single lessons that get in the way
    // push the start back from THAT date, exactly as they always did.
    if (startFrom && /^\d{4}-\d{2}-\d{2}$/.test(String(startFrom))) {
      const aheadDays = (new Date(startFrom + 'T00:00:00') - new Date(todayStr + 'T00:00:00')) / 86400000;
      if (aheadDays > MAX_START_AHEAD_DAYS) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please choose a start date within the next 3 months.' }) };
      }
      const dayBefore = new Date(startFrom + 'T00:00:00Z'); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      const chosenFirst = nextOccurrenceDate(Number(dow), time, MIN_NOTICE_HOURS, dayBefore.toISOString().slice(0, 10));
      if (chosenFirst && normalFirst && chosenFirst > normalFirst) normalFirst = chosenFirst;
    }
    startDate = normalFirst;
    const lastConflict = conflictDates.sort().pop();
    if (normalFirst && lastConflict && lastConflict >= normalFirst) {
      startDate = nextOccurrenceDate(Number(dow), time, MIN_NOTICE_HOURS, lastConflict);
      const delayDays = Math.round((new Date(startDate + 'T00:00:00') - new Date(normalFirst + 'T00:00:00')) / 86400000);
      if (delayDays > MAX_START_DELAY_DAYS) {
        const nice = (ds) => new Date(ds + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Single lessons are already booked at that time until ' + nice(lastConflict) + ', so a weekly slot there could not start until ' + nice(startDate) + '. Please choose a different day or time, or contact James.' }) };
      }
    }
  } catch (checkErr) {
    // Fails open, as before: the webhook re-checks after payment and
    // refunds if the slot turns out to be taken.
    startDate = null;
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
    const sessionParams = {
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
          goalsNotes: (goalsNotes || '').slice(0, 450),
          // First lesson date, so stripe-webhook.js books THIS date rather
          // than working it out again (it would not know about single
          // lessons that pushed the start back).
          ...(startDate ? { startDate: startDate } : {})
        }
      },
      success_url: siteUrl + '/booking.html?subscribed=1#subscribe',
      cancel_url: siteUrl + '/booking.html#subscribe'
    };
    // WHEN STUDENTS ARE CHARGED: a few days before each lesson, not at the
    // moment they enroll. Stripe charges a subscription on a fixed rhythm
    // (every 7 or 14 days) from its first charge, so what matters is
    // choosing that first charge date well:
    //   - first lesson comfortably far away: nothing is charged today; the
    //     first charge is 3 days before the first lesson, and every charge
    //     after that is 3 days before its lesson too ('later').
    //   - first lesson too close for that (Stripe needs a charge date a few
    //     days ahead): they pay for the first lesson today, and the regular
    //     billing starts 3 days before their second lesson ('now').
    // If anything here can't be worked out safely, it quietly falls back to
    // the plain billing this used to do (charge now, then every 7/14 days).
    const CHARGE_DAYS_BEFORE = 3;
    const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const niceDay = (ds) => new Date(ds + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
    let billingPlan = null;
    if (startDate) {
      try {
        const interval = frequency === 'fortnightly' ? 14 : 7;
        const nowSecs = Math.floor(Date.now() / 1000);
        const chargeSecs = (ds) => Math.floor(melbourneEpochMs(ds, '9:00 am') / 1000);
        // Stripe needs a trial to end well in the future; stay clear of both edges.
        const usable = (secs) => (secs - nowSecs) > 3 * 86400 && (secs - nowSecs) < 200 * 86400;
        const firstCharge = addDays(startDate, -CHARGE_DAYS_BEFORE);
        if (usable(chargeSecs(firstCharge))) {
          billingPlan = { mode: 'later', trialEnd: chargeSecs(firstCharge), billingStartDate: firstCharge };
        } else {
          const secondCharge = addDays(addDays(startDate, interval), -CHARGE_DAYS_BEFORE);
          if (usable(chargeSecs(secondCharge))) {
            const recurringPrice = await stripe.prices.retrieve(priceId);
            if (recurringPrice && recurringPrice.unit_amount > 0 && recurringPrice.currency === 'aud') {
              billingPlan = { mode: 'now', trialEnd: chargeSecs(secondCharge), billingStartDate: secondCharge, unitAmount: recurringPrice.unit_amount };
            }
          }
        }
      } catch (planErr) {
        billingPlan = null;
        console.error('[create-subscription] custom billing not used:', planErr && planErr.message ? planErr.message : planErr);
      }
    }
    if (billingPlan) {
      sessionParams.subscription_data.trial_end = billingPlan.trialEnd;
      sessionParams.subscription_data.metadata.billingStartDate = billingPlan.billingStartDate;
      if (billingPlan.mode === 'later') {
        sessionParams.subscription_data.metadata.firstPayment = 'later';
        // Also on the session itself, so stripe-webhook.js can tell from
        // checkout.session.completed that this one needs setting up now.
        sessionParams.metadata = { mcq_first_payment: 'later' };
      } else {
        sessionParams.line_items.push({
          price_data: { currency: 'aud', unit_amount: billingPlan.unitAmount, product_data: { name: 'First lesson (' + niceDay(startDate) + ')' } },
          quantity: 1
        });
      }
    }

    // Tells the student their actual first lesson date on the payment page
    // itself, before they pay (it can be a week or two out when a single
    // lesson already sits in the slot).
    if (startDate) {
      const niceStart = new Date(startDate + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
      let billingLine = '';
      if (billingPlan && billingPlan.mode === 'later') billingLine = ' You will not be charged today: your first payment is taken on ' + niceDay(billingPlan.billingStartDate) + ', then a few days before each lesson.';
      else if (billingPlan) billingLine = ' You pay for it today, then your next payment is taken on ' + niceDay(billingPlan.billingStartDate) + ', a few days before each lesson.';
      sessionParams.custom_text = { submit: { message: 'Your first lesson is ' + niceStart + ' at ' + time + '.' + billingLine } };
    }
    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionParams);
    } catch (firstErr) {
      // Never let the extra text be the reason someone can't enroll.
      if (!sessionParams.custom_text) throw firstErr;
      delete sessionParams.custom_text;
      session = await stripe.checkout.sessions.create(sessionParams);
    }

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
