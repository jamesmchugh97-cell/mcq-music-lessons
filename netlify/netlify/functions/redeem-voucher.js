// redeem-voucher.js
// Netlify serverless function: books lessons using a gift voucher. The person
// with the code picks their own dates (all of them, or just a few now and the
// rest later); there is no card payment because the voucher is already paid.
//
// It uses exactly the same booking rules as every other booking (business
// hours, no overlaps, spacing between lessons, enrolled students' slots,
// 3 months ahead) by going through reserve-multi-slots.js - that is what
// keeps the times safe from double booking. The steps:
//   1. Hold the times (reserve-multi-slots.js, flagged as a voucher booking
//      on the server side only, so a browser can't use that flag).
//   2. Use up that many lessons from the voucher. This is checked after
//      writing, not only before, so two people using the same voucher at the
//      same moment can't both get the last lessons: only an entry that is
//      still in the voucher afterwards counts, and the other is undone.
//   3. Confirm the lessons (they were held as unpaid; a voucher is already paid).
//   4. Email the student and James.
// If anything fails after the times were held, the held times and their
// calendar events are released again.
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { handler: reserveHandler } = require('./reserve-multi-slots');
const { deleteCalendarEvent } = require('./google-calendar-helper');
const { getVoucher, vouchersStore, lessonsRemaining, isExpired, normalizeCode, lockoutMinutesLeft, recordMiss } = require('./voucher-helpers');
const emailTemplate = require('./email-template');

const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

async function sendEmail(to, subject, html, text) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>', reply_to: 'jamesmcqmusic@gmail.com', to: [to], subject: subject, html: html, ...(text ? { text: text } : {}) })
    });
  } catch (e) {
    console.error('[redeem-voucher] email failed:', e && e.message ? e.message : e);
  }
}

function nice(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fail(message) {
  return { statusCode: 200, body: JSON.stringify({ success: false, error: message }) };
}

async function releaseHeldTimes(slots, claimId) {
  const bookings = bookingsStore();
  for (const s of slots) {
    const key = s.date + '_' + s.time;
    try {
      const rec = await bookings.get(key, { type: 'json' });
      if (rec && rec.claimId === claimId) {
        await bookings.delete(key);
        if (rec.eventId) { try { await deleteCalendarEvent(rec.eventId); } catch (e) {} }
      }
    } catch (e) {}
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body' }) };
  }
  const { slots, name, email, instrument, guitar_type, skill_level, song_requests, genre_focus, theory_interest, lesson_goals_notes } = body;
  const code = normalizeCode(body.code);

  const locked = await lockoutMinutesLeft(event);
  if (locked > 0) return fail('Too many wrong codes. Please try again in about ' + locked + ' minute(s), or contact James.');
  if (!code) { await recordMiss(event); return fail('Please enter your voucher code.'); }
  if (!name || !String(name).trim() || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return fail('Please enter your name and a valid email address.');
  if (!Array.isArray(slots) || slots.length === 0) return fail('Please choose a date and time for at least one lesson.');
  if (slots.length > 10) return fail('Please choose at most 10 lessons at a time.');

  try {
    const voucher = await getVoucher(code);
    if (!voucher) { await recordMiss(event); return fail('We couldn\'t find a voucher with that code. Please check it and try again.'); }
    if (voucher.status === 'void') return fail('This voucher is no longer valid. Please contact James.');
    if (isExpired(voucher)) return fail('This voucher expired on ' + nice(voucher.expiresAt) + '. Please contact James.');
    const remaining = lessonsRemaining(voucher);
    if (remaining <= 0) return fail('All the lessons on this voucher have already been booked.');
    if (slots.length > remaining) return fail('This voucher has ' + remaining + ' lesson' + (remaining === 1 ? '' : 's') + ' left, but you chose ' + slots.length + '. Please remove ' + (slots.length - remaining) + '.');

    // 1. hold the times, using the normal booking rules
    const reserveResp = await reserveHandler({
      httpMethod: 'POST',
      headers: event.headers || {},
      __internalVoucher: true,
      body: JSON.stringify({
        slots: slots, name: String(name).trim(), email: String(email).trim(), duration: voucher.durationMinutes,
        instrument: instrument, guitar_type: guitar_type, skill_level: skill_level,
        song_requests: song_requests, genre_focus: genre_focus, theory_interest: theory_interest, lesson_goals_notes: lesson_goals_notes
      })
    });
    const held = JSON.parse(reserveResp.body);
    if (!held.success) return { statusCode: 200, body: reserveResp.body };
    const claimId = held.claimId;

    // 2. confirm the lessons FIRST (they were held as unpaid; the voucher already covers them).
    // This order matters: if this request were ever cut off part way (a slow calendar, a
    // time limit), the worst outcome is lessons that are booked but not yet counted against
    // the voucher - which the 10-minute clean-up job notices and corrects (see
    // reconcileVoucherLessons in pending-hold-cleanup.js) - rather than a customer's
    // lessons being counted as used for times that quietly expire.
    const bookings = bookingsStore();
    const confirmed = await Promise.all(slots.map(async (s) => {
      const key = s.date + '_' + s.time;
      try {
        const rec = await bookings.get(key, { type: 'json' });
        if (!rec || rec.claimId !== claimId) return false;
        delete rec.pendingPayment;
        delete rec.reservedAt;
        rec.voucherCode = code;
        await bookings.set(key, JSON.stringify(rec));
        return true;
      } catch (e) {
        console.error('[redeem-voucher] could not confirm', key, ':', e && e.message ? e.message : e);
        return false;
      }
    }));
    if (!confirmed.every(Boolean)) {
      await releaseHeldTimes(slots, claimId);
      return fail('Something went wrong confirming those lessons, so nothing was used from your voucher. Please try again.');
    }

    // 3. use the lessons up, and check it really counted
    const vouchers = vouchersStore();
    let counted = false;
    try {
      const fresh = await vouchers.get(code, { type: 'json' });
      if (fresh && fresh.status !== 'void' && !isExpired(fresh) && lessonsRemaining(fresh) >= slots.length) {
        fresh.redemptions = fresh.redemptions || [];
        fresh.redemptions.push({
          claimId: claimId, at: new Date().toISOString(), lessons: slots.length,
          dates: slots.map(s => s.date + ' ' + s.time), name: String(name).trim(), email: String(email).trim().toLowerCase()
        });
        await vouchers.set(code, JSON.stringify(fresh));
        // Short pause so that if two redemptions land at the same instant, both
        // read back the same final voucher and only the one still in it counts.
        await new Promise(resolve => setTimeout(resolve, 250));
        const back = await vouchers.get(code, { type: 'json' });
        counted = !!(back && (back.redemptions || []).some(r => r.claimId === claimId) && lessonsRemaining(back) >= 0 &&
          (back.redemptions || []).reduce((n, r) => n + (r.lessons || 0), 0) <= back.lessonsTotal);
      }
    } catch (e) {
      counted = false;
    }
    if (!counted) {
      // Undo: remove the lessons we just confirmed (and their calendar events), and our entry if it got in.
      await releaseHeldTimes(slots, claimId);
      try {
        const cur = await vouchers.get(code, { type: 'json' });
        if (cur && (cur.redemptions || []).some(r => r.claimId === claimId)) {
          cur.redemptions = cur.redemptions.filter(r => r.claimId !== claimId);
          await vouchers.set(code, JSON.stringify(cur));
        }
      } catch (e) {}
      return fail('Those lessons could not be taken from the voucher just now - someone may have used it at the same moment. Please check how many lessons are left and try again.');
    }

    // 4. emails
    const after = await vouchers.get(code, { type: 'json' });
    const left = after ? lessonsRemaining(after) : remaining - slots.length;
    const detail = { name: String(name).trim(), email: String(email).trim(), slots: slots, durationMinutes: voucher.durationMinutes, instrument: instrument, guitarType: guitar_type, skillLevel: skill_level, left: left, code: code };
    const studentMail = emailTemplate.lessonsBookedEmail(detail);
    const jamesMail = emailTemplate.voucherBookedEmailForJames(detail);
    await Promise.all([
      sendEmail(String(email).trim(), studentMail.subject, studentMail.html, studentMail.text),
      sendEmail(JAMES_EMAIL, jamesMail.subject, jamesMail.html, jamesMail.text)
    ]);

    return { statusCode: 200, body: JSON.stringify({ success: true, lessonsBooked: slots.length, lessonsRemaining: left, slots: slots }) };
  } catch (err) {
    console.error('[redeem-voucher] error:', err && err.message ? err.message : err);
    return fail('Something went wrong booking those lessons. Please try again, or contact James.');
  }
};
