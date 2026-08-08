// Netlify serverless function: lets a student cancel their own lesson.
// Verifies the email matches the booking before cancelling (so nobody can
// cancel someone else's lesson), always frees the slot, and emails both
// the student and James so nothing slips through unnoticed. Refunds are
// never issued automatically: a 24+ hour cancellation grants a free
// single-use reschedule credit for the rest of that week (Mon-Sat), and
// if the student doesn't use it, the lesson simply isn't refunded.
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');
const { deleteCalendarEvent } = require('./google-calendar-helper');

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

// Converts a date ('YYYY-MM-DD') and time ('3:00 pm') given as Melbourne
// LOCAL wall-clock time into a true UTC epoch timestamp (ms), correctly
// accounting for daylight saving. Netlify's servers run in UTC, so naive
// Date parsing here would otherwise be off by 10-11 hours from what
// Melbourne actually experiences, this keeps the 24-hour cancellation
// eligibility check accurate regardless of the server's own timezone.
function melbourneEpochMs(dateStr, timeStr) {
  const minutes = timeToMinutes(timeStr) || 0;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const hour = Math.floor(minutes / 60);
  const min = minutes % 60;
  const naiveUtcMs = Date.UTC(y, mo - 1, d, hour, min);
  let offsetMinutes = 600; // fallback: AEST, UTC+10:00
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Melbourne', timeZoneName: 'shortOffset' });
    const part = dtf.formatToParts(new Date(naiveUtcMs)).find(p => p.type === 'timeZoneName');
    const match = part && part.value.match(/GMT([+-]\d+)(?::(\d+))?/);
    if (match) {
      const sign = match[1][0] === '-' ? -1 : 1;
      offsetMinutes = parseInt(match[1], 10) * 60 + sign * parseInt(match[2] || '0', 10);
    }
  } catch (e) {}
  return naiveUtcMs - offsetMinutes * 60000;
}

function formatDateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// The reschedule credit's window is Monday of the week the cancelled
// lesson fell in, through to the Saturday of the FOLLOWING week (a full
// fortnight), so a student who's genuinely unwell (a cold that runs past
// what's left of the current week, for example) still has a real chance
// to use it, not just whatever days happen to be left in the current week.
function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return formatDateKey(d);
}

function fortnightEnd(dateStr) {
  const mon = mondayOfWeek(dateStr);
  const d = new Date(mon + 'T00:00:00');
  d.setDate(d.getDate() + 12); // Monday + 12 days = Saturday of the following week
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
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body' }) };
  }
  const { email, date, time } = body;
  if (!email || !date || !time) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing email, date, or time.' }) };
  }

  const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
  const key = date + '_' + time;

  try {
    const record = await store.get(key, { type: 'json' });
    if (!record) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That lesson could not be found. It may already be cancelled.' }) };
    }
    if (!record.email || record.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That lesson is not associated with this email address.' }) };
    }

    await store.delete(key);

    // Remove the matching Google Calendar event, if this booking has one
    // (older bookings made before the calendar integration existed won't
    // have an eventId, which is fine — just nothing to delete). This is
    // best-effort: a calendar failure must never block the cancellation
    // itself from going through.
    if (record.eventId) {
      console.log('[cancel-booking] attempting calendar delete for', key, 'eventId:', record.eventId);
      try {
        await deleteCalendarEvent(record.eventId);
        console.log('[cancel-booking] calendar delete succeeded for', key);
      } catch (calErr) {
        console.error('Google Calendar event deletion failed for ' + key + ':', calErr && calErr.message ? calErr.message : calErr);
      }
    } else {
      console.log('[cancel-booking] no eventId on record for', key, '- nothing to delete from calendar (likely a pre-fix booking)');
    }

    const hoursUntil = (melbourneEpochMs(date, time) - Date.now()) / (1000 * 60 * 60);
    const eligible = hoursUntil >= 24;

    // Reschedule credit: when eligible, this cancelled lesson was already
    // paid for, so rebooking anywhere Mon-Sat within the same week should
    // never charge the student again. A random single-use token is stored
    // server-side with the week window it's valid for; the rebook link
    // only ever carries this opaque token, never payment details or a way
    // to book for free outside that specific window.
    let rescheduleToken = null;
    if (eligible) {
      rescheduleToken = crypto.randomBytes(16).toString('hex');
      const weekStart = mondayOfWeek(date);
      const weekEnd = fortnightEnd(date);
      try {
        const rescheduleStore = getStore({ name: 'reschedule-credits', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
        await rescheduleStore.setJSON(rescheduleToken, {
          email: email.trim().toLowerCase(),
          name: record.name || 'there',
          duration: record.duration || 45,
          weekStart: weekStart,
          weekEnd: weekEnd,
          originalDate: date,
          originalTime: time,
          used: false,
          createdAt: new Date().toISOString()
        });
      } catch (e) {
        rescheduleToken = null;
      }
    }

    // Rebook link: sends the student to a dedicated, no-payment reschedule
    // panel (not the normal paid booking form), pre-filled with their
    // details from the credit above, so it's obvious this is moving their
    // existing paid lesson rather than buying a new one.
    const rebookButtonHtml = rescheduleToken
      ? '<p style="text-align:center;margin:24px 0;"><a href="https://mcqmusiclessons.com.au/booking.html?reschedule=' + rescheduleToken + '#reschedulePanel" style="background:#c9942a;color:#1a1a1a;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:600;display:inline-block;">Rebook within the next 2 weeks (no charge) &rarr;</a></p>'
      : '';

    const studentName = record.name || 'there';
    const studentHtml =
      '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">' +
      '<div style="text-align:center;margin-bottom:24px;">' +
      '<p style="font-family:Georgia,\'Times New Roman\',serif;font-size:24px;color:#c9942a;margin:0;">&#9834; MCQ Music</p>' +
      '</div>' +
      '<h2 style="text-align:center;font-family:Georgia,serif;font-weight:normal;">Lesson Cancelled</h2>' +
      '<p>Hi ' + studentName + ',</p>' +
      '<p>Your lesson on <strong>' + date + ' at ' + time + '</strong> has been cancelled as requested.</p>' +
      rebookButtonHtml +
      '<p>' + (eligible
        ? "You've got 24+ hours' notice, so you can move this lesson to a new time yourself, any day over the next two weeks (Monday through Saturday), with no extra charge, no need to contact James. If you don't rebook within that fortnight, this lesson won't be refunded."
        : "As this was cancelled with less than 24 hours' notice, the full lesson fee applies and no rebooking is available.") + '</p>' +
      '<p style="font-size:0.85em;color:#666;">Questions? Reply to this email or call 0499 232 898.</p>' +
      // Invisible per-email marker: Gmail auto-collapses content it
      // recognises as a repeated "signature" across emails from the same
      // sender, since every email ends with that same "Questions?" line.
      // This unique, invisible token makes each email's HTML byte-for-byte
      // different, so Gmail can't pattern-match it as identical boilerplate
      // and the rebook button above stays visible instead of hiding
      // behind "..." in the inbox.
      '<span style="display:none;">Ref ' + date + '-' + time.replace(/[^0-9]/g, '') + '-' + crypto.randomBytes(4).toString('hex') + '</span>' +
      '</div>';
    await sendEmail(email, 'Your lesson has been cancelled', studentHtml);

    const jamesHtml =
      '<div style="font-family:-apple-system,sans-serif;">' +
      '<h3>Lesson cancelled</h3>' +
      '<p><strong>' + studentName + '</strong> (' + email + ') cancelled their lesson on <strong>' + date + ' at ' + time + '</strong>.</p>' +
      '<p>Notice given: ' + hoursUntil.toFixed(1) + ' hours (' + (eligible ? 'eligible for a free self-service reschedule within the next fortnight' : 'within 24 hours \u2014 no rebooking, full fee applies') + ').</p>' +
      '</div>';
    await sendEmail('jamesmcqmusic@gmail.com', 'Booking cancelled: ' + studentName + ' \u2014 ' + date + ' ' + time, jamesHtml);

    return { statusCode: 200, body: JSON.stringify({ success: true, eligible: eligible }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
