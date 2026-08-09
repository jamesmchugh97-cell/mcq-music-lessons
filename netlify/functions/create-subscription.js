// create-subscription.js
// Netlify serverless function: starts a recurring weekly/fortnightly
// lesson subscription for a student. Checks the requested day/time/
// duration doesn't clash with an existing recurring student or an
// upcoming one-off booking, then creates a Stripe Checkout Session in
// subscription mode. The actual booking + calendar event for each lesson
// is created later by stripe-webhook.js when Stripe confirms payment
// (invoice.payment_succeeded) — this function only starts the
// subscription and never writes a booking record itself.
const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const MIN_GAP_MINUTES = 30;
const CONFLICT_CHECK_WEEKS = 8; // how many upcoming weeks of one-off bookings to scan for a clash

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

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay();
}

const FRI_SAT_CLOSING_MINUTES = 16 * 60 + 30;
const MON_THU_CLOSING_MINUTES = 21 * 60;

function isWithinBusinessHours(dateStr, startMinutes, endMinutes) {
  const dow = dayOfWeek(dateStr);
  if (dow === 5 || dow === 6) return endMinutes <= FRI_SAT_CLOSING_MINUTES;
  if (dow === 0) return false; // Sunday closed
  return endMinutes <= MON_THU_CLOSING_MINUTES;
}

// Same hardcoded roster used by reserve-multi-slots.js. Kept in sync
// manually — after a new subscription is confirmed, James still needs
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

// Maps duration + frequency to the correct pre-created Stripe Price ID.
const PRICE_IDS = {
  '30_weekly': 'price_1U2PyCAOM8tPKKgkdcq71eaP',
  '30_fortnightly': 'price_1U2Q23AOM8tPKKgkzEozmG31',
  '45_weekly': 'price_1U2Q64AOM8tPKKgkxAsei52J',
  '45_fortnightly': 'price_1U2Q7LAOM8tPKKgkQovjrxBD',
  '60_weekly': 'price_1U2Q8jAOM8tPKKgkd1rMpX1A',
  '60_fortnightly': 'price_1U2Q9AAOM8tPKKgk3VG8itQN',
  '75_weekly': 'price_1U2QBIAOM8tPKKgkrNFPjDhZ',
  '75_fortnightly': 'price_1U2QBkAOM8tPKKgkMnVMuT2O',
  '90_weekly': 'price_1U2QCNAOM8tPKKgkJUtWzyEL',
  '90_fortnightly': 'price_1U2QCqAOM8tPKKgknCBOj1VG'
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

  const { studentName, studentEmail, instrument, dayOfWeek: dow, time, durationMinutes, frequency } = body;

  if (!studentName || !studentEmail || !instrument || dow === undefined || !time || !durationMinutes || !frequency) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing required subscription details.' }) };
  }
  if (frequency !== 'weekly' && frequency !== 'fortnightly') {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Frequency must be weekly or fortnightly.' }) };
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

  // Business hours check uses a placeholder date matching the target
  // weekday just to reuse the same Mon-Thu/Fri-Sat closing rules.
  const placeholderDates = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
  const placeholderDate = placeholderDates[dow] || placeholderDates[1];
  if (!isWithinBusinessHours(placeholderDate, startMinutes, endMinutes)) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time falls outside business hours for that day.' }) };
  }

  if (conflictsWithRoster(dow, startMinutes, endMinutes)) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That slot is already taken by another regular student. Please choose a different day or time.' }) };
  }

  // Also check upcoming one-off Blobs bookings on that weekday for the
  // next few weeks, so a subscription can't be started on top of a slot
  // someone already booked as a single lesson.
  try {
    const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
    const today = new Date();
    for (let i = 0; i < CONFLICT_CHECK_WEEKS * 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      if (d.getDay() !== dow) continue;
      const dateStr = d.toISOString().slice(0, 10);
      const { blobs } = await store.list({ prefix: dateStr + '_' });
      for (const blob of blobs) {
        const record = await store.get(blob.key, { type: 'json' });
        if (!record || !record.time) continue;
        const exStart = timeToMinutes(record.time);
        const exEnd = exStart + (record.duration || 45);
        const overlap = startMinutes < exEnd && exStart < endMinutes;
        if (overlap) {
          return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That slot is already booked on ' + dateStr + '. Please choose a different day or time.' }) };
        }
      }
    }
  } catch (checkErr) {
    console.error('[create-subscription] conflict check failed:', checkErr && checkErr.message ? checkErr.message : checkErr);
  }

  try {
    const siteUrl = process.env.URL || 'https://mcqmusiclessons.com.au';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: studentEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: {
          studentName: studentName,
