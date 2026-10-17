// pending-hold-cleanup.js
// Netlify SCHEDULED function, runs every 10 minutes. Proactively sweeps
// every booking record in the store looking for stale, abandoned
// pending-payment holds (see isStalePendingHold in
// subscription-helpers.js) and cleans up both the booking record AND
// its Google Calendar event.
//
// Every place that CHECKS for a conflict already treats a stale hold
// as if it weren't there - but nothing was ever proactively removing
// the underlying record or its calendar event unless someone else
// happened to try booking that exact same date and time again later.
// If nobody ever contests that slot, an abandoned checkout (a failed
// card, a closed tab, anything short of completing payment) would
// leave a real-looking event sitting on James's calendar forever,
// showing a student as booked in who never actually paid - directly
// undermining the calendar as an accurate, trustworthy record of who's
// actually booked without having to dig through email or Stripe.
const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');
const { isStalePendingHold, isPendingHoldExpired, escapeHtml } = require('./subscription-helpers');
const { vouchersStore, lessonsRemaining } = require('./voucher-helpers');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

async function notifyJames(subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>', reply_to: 'jamesmcqmusic@gmail.com', to: [JAMES_EMAIL], subject: subject, html: html })
    });
  } catch (e) {
    console.error('[pending-hold-cleanup] notify failed:', e && e.message ? e.message : e);
  }
}

// For an expired hold that has a Stripe payment attached: returns
// 'paid' (confirm it), 'unpaid' (safe to release) or 'unknown' (leave
// it alone and try again next run - e.g. Stripe unreachable, or the
// payment is still 'processing').
async function paymentOutcome(paymentIntentId) {
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status === 'succeeded') return 'paid';
    if (['requires_payment_method', 'requires_action', 'requires_confirmation', 'canceled'].includes(pi.status)) return 'unpaid';
    return 'unknown';
  } catch (e) {
    console.error('[pending-hold-cleanup] Stripe lookup failed for', paymentIntentId, ':', e && e.message ? e.message : e);
    return 'unknown';
  }
}
const { deleteCalendarEvent } = require('./google-calendar-helper');

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

// Safety net for gift vouchers. redeem-voucher.js confirms the lessons first and
// counts them against the voucher second. If a request were ever cut off in between
// (a slow calendar, a time limit), the lessons would be booked but not yet counted.
// Booked lessons are the source of truth, so this adds the missing entry to the
// voucher (after waiting 15 minutes, so it never races a booking still in progress)
// and tells James. Only lessons booked straight from a voucher count: lessons moved by
// a reschedule link carry no claim id, and cancelled lessons are simply not in the list.
async function reconcileVoucherLessons(groups) {
  const vstore = vouchersStore();
  for (const g of Object.values(groups)) {
    try {
      const v = await vstore.get(g.code, { type: 'json' });
      if (!v) continue;
      if ((v.redemptions || []).some(r => r.claimId === g.claimId)) continue; // already counted
      v.redemptions = v.redemptions || [];
      v.redemptions.push({ claimId: g.claimId, at: new Date().toISOString(), lessons: g.dates.length, dates: g.dates.slice().sort(), name: g.name, email: (g.email || '').toLowerCase(), reconciled: true });
      await vstore.set(g.code, JSON.stringify(v));
      const used = v.redemptions.reduce((n, r) => n + (r.lessons || 0), 0);
      console.log('[pending-hold-cleanup] counted', g.dates.length, 'voucher lesson(s) that were booked but never counted against', g.code);
      await notifyJames(
        'Voucher corrected: ' + g.code,
        '<p>' + g.dates.length + ' lesson(s) booked by ' + escapeHtml(g.name || 'a student') + ' (' + escapeHtml(g.email || '') + ') on gift voucher <strong>' + escapeHtml(g.code) + '</strong> had not been counted against it (a booking request was probably cut off part way). I have counted them now.</p>' +
        '<p>The voucher now has <strong>' + lessonsRemaining(v) + '</strong> lesson(s) left.' + (used > v.lessonsTotal ? ' <strong>It has been used ' + (used - v.lessonsTotal) + ' lesson(s) beyond what was paid for</strong> - you may want to check.' : '') + '</p>'
      );
    } catch (e) {
      console.error('[pending-hold-cleanup] voucher reconcile failed for', g.code, ':', e && e.message ? e.message : e);
    }
  }
}

async function run() {
  const store = bookingsStore();
  const voucherGroups = {};
  let swept = 0;
  let checked = 0;
  try {
    const { blobs } = await store.list();
    for (const blob of blobs) {
      checked++;
      let record;
      try {
        record = await store.get(blob.key, { type: 'json' });
      } catch (e) {
        console.error('[pending-hold-cleanup] failed to read', blob.key, ':', e && e.message ? e.message : e);
        continue;
      }
      if (record && record.voucherCode && record.claimId && record.pendingPayment !== true && !record.rescheduledFrom &&
          record.bookedAt && Date.now() - new Date(record.bookedAt).getTime() > 15 * 60 * 1000) {
        const gk = record.voucherCode + '|' + record.claimId;
        if (!voucherGroups[gk]) voucherGroups[gk] = { code: record.voucherCode, claimId: record.claimId, name: record.name, email: record.email, dates: [] };
        voucherGroups[gk].dates.push(record.date + ' ' + record.time);
      }
      if (record && record.paymentIntentId && isPendingHoldExpired(record)) {
        const outcome = await paymentOutcome(record.paymentIntentId);
        if (outcome === 'paid') {
          try {
            delete record.pendingPayment;
            delete record.reservedAt;
            await store.set(blob.key, JSON.stringify(record));
            console.log('[pending-hold-cleanup] confirmed PAID booking that was never confirmed by the browser:', blob.key);
            await notifyJames(
              'Booking confirmed (check student got their email): ' + (record.name || 'Student') + ', ' + record.date + ' ' + record.time,
              '<p>' + escapeHtml(record.name || 'A student') + ' (' + escapeHtml(record.email || 'no email') + ') paid for a lesson on <strong>' + escapeHtml(record.date) + ' at ' + escapeHtml(record.time) + '</strong>, but their browser never finished the booking (closed tab, lost connection, etc.).</p><p>The booking is now confirmed and stays on your calendar. They may not have received their confirmation email, so it could be worth a quick message to let them know they\'re booked in.</p>'
            );
          } catch (e) {
            console.error('[pending-hold-cleanup] failed to confirm paid hold', blob.key, ':', e && e.message ? e.message : e);
          }
          continue;
        }
        if (outcome === 'unknown') continue;
        // 'unpaid' falls through to the normal release below.
      } else if (!isStalePendingHold(record)) {
        continue;
      }
      try {
        await store.delete(blob.key);
        if (record.eventId) {
          try {
            await deleteCalendarEvent(record.eventId);
          } catch (calErr) {
            console.error('[pending-hold-cleanup] calendar delete failed for', blob.key, ':', calErr && calErr.message ? calErr.message : calErr);
          }
        }
        swept++;
        console.log('[pending-hold-cleanup] swept stale hold at', blob.key, 'reserved at', record.reservedAt);
      } catch (e) {
        console.error('[pending-hold-cleanup] failed to delete', blob.key, ':', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    console.error('[pending-hold-cleanup] failed to list bookings store:', e && e.message ? e.message : e);
  }
  console.log('[pending-hold-cleanup] checked', checked, 'records, swept', swept, 'stale holds');

  await reconcileVoucherLessons(voucherGroups);

  // Orphaned calendar events: every event reserve-multi-slots creates is
  // noted in the calendar-ledger store. Once an entry is an hour old,
  // check its booking: if the booking is gone or now points at a
  // different event (it was replaced or rolled back), remove the stray
  // event from James's calendar; if the booking is confirmed and still
  // owns this event, it's settled and the ledger entry is just dropped.
  try {
    const ledger = getStore({ name: 'calendar-ledger', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
    const { blobs: entries } = await ledger.list();
    let orphansRemoved = 0;
    for (const entry of entries) {
      try {
        const info = await ledger.get(entry.key, { type: 'json' });
        if (!info || !info.createdAt) { await ledger.delete(entry.key); continue; }
        if (Date.now() - new Date(info.createdAt).getTime() < 60 * 60 * 1000) continue;
        const booking = await store.get(info.bookingKey, { type: 'json' });
        if (booking && booking.eventId === entry.key) {
          if (booking.pendingPayment !== true) await ledger.delete(entry.key); // settled
          continue; // still pending: the hold logic above deals with it
        }
        try { await deleteCalendarEvent(entry.key); orphansRemoved++; } catch (e) {} // already gone is fine
        await ledger.delete(entry.key);
      } catch (e) {
        console.error('[pending-hold-cleanup] ledger check failed for', entry.key, ':', e && e.message ? e.message : e);
      }
    }
    if (orphansRemoved) console.log('[pending-hold-cleanup] removed', orphansRemoved, 'orphaned calendar events');
  } catch (e) {
    console.error('[pending-hold-cleanup] calendar ledger sweep failed:', e && e.message ? e.message : e);
  }
  return { statusCode: 200, body: 'ok' };
}

exports.handler = schedule('*/10 * * * *', run);
