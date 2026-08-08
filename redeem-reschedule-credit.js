// Netlify serverless function: redeems a reschedule credit (granted by
// cancel-booking.js when a student cancels with 24+ hours' notice) into an
// actual new booking, with NO payment step, since the student already paid
// for the lesson they cancelled, this only moves it to a new slot. Checks
// the credit is unused, unexpired, and that the chosen date falls inside
// the same week it was granted for, then reserves the slot exactly like a
// normal booking (blocking anyone else from taking it) and emails a
// confirmation that makes clear no charge was made.
const { getStore } = require('@netlify/blobs');

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

// Same Melbourne-local-time-to-epoch conversion used in cancel-booking.js,
// so the 24-hour notice check here is correct regardless of the server's
// own timezone or daylight saving.
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

const FRI_SAT_CLOSING_MINUTES = 16 * 60 + 30; // 4:30 pm
const MON_THU_CLOSING_MINUTES = 21 * 60; // 9:00 pm

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
  const { token, date, time } = body;
  if (!token || !date || !time) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing token, date, or time.' }) };
  }

  const creditsStore = getStore({ name: 'reschedule-credits', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });

  try {
    const credit = await creditsStore.get(token, { type: 'json' });
    if (!credit) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'This reschedule link is invalid. Please contact James directly.' }) };
    }
    if (credit.used) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'This reschedule link has already been used.' }) };
    }
    const todayStr = new Date().toISOString().split('T')[0];
    if (todayStr > credit.weekEnd) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'This reschedule link has expired.' }) };
    }
    if (date < credit.weekStart || date > credit.weekEnd) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please choose a date within your rebooking window.' }) };
    }

    const startMinutes = timeToMinutes(time);
    if (startMinutes === null) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Invalid time format.' }) };
    }
    const duration = credit.duration || 45;
    const endMinutes = startMinutes + duration;
    const dow = new Date(date + 'T00:00:00').getDay();
    if (dow === 0) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'James is closed on Sundays.' }) };
    }
    const closingMinutes = (dow === 5 || dow === 6) ? FRI_SAT_CLOSING_MINUTES : MON_THU_CLOSING_MINUTES;
    if (endMinutes > closingMinutes) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time runs past closing hours for that day.' }) };
    }
    const hoursUntil = (melbourneEpochMs(date, time) - Date.now()) / (1000 * 60 * 60);
    if (hoursUntil < 24) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time is less than 24 hours away. Please choose a later slot.' }) };
    }

    const bookingsStore = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
    const key = date + '_' + time;
    const existing = await bookingsStore.get(key, { type: 'json' });
    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time was just taken. Please pick a different slot.' }) };
    }

    await bookingsStore.setJSON(key, {
      name: credit.name,
      email: credit.email,
      duration: duration,
      rescheduledFrom: credit.originalDate + ' ' + credit.originalTime
    });

    credit.used = true;
    await creditsStore.setJSON(token, credit);

    const html =
      '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">' +
      '<div style="text-align:center;margin-bottom:24px;">' +
      '<p style="font-family:Georgia,\'Times New Roman\',serif;font-size:24px;color:#c9942a;margin:0;">&#9834; MCQ Music</p>' +
      '</div>' +
      '<h2 style="text-align:center;font-family:Georgia,serif;font-weight:normal;">Lesson Rescheduled</h2>' +
      '<p>Hi ' + (credit.name || 'there') + ', your lesson is now booked for <strong>' + date + ' at ' + time + '</strong>. No payment was needed, this simply moves the lesson you already paid for.</p>' +
      '<p><strong>Location:</strong> 84 Nelson Road, South Melbourne VIC 3205</p>' +
      '<p style="font-size:0.85em;color:#666;">Questions? Reply to this email or call 0499 232 898.</p>' +
      '</div>';
    await sendEmail(credit.email, 'Your lesson has been rescheduled', html);

    const jamesHtml =
      '<div style="font-family:-apple-system,sans-serif;">' +
      '<h3>Lesson rescheduled (no charge)</h3>' +
      '<p><strong>' + (credit.name || 'A student') + '</strong> (' + credit.email + ') moved their cancelled lesson from <strong>' + credit.originalDate + ' ' + credit.originalTime + '</strong> to <strong>' + date + ' ' + time + '</strong>, using their reschedule credit. No new payment was taken.</p>' +
      '</div>';
    await sendEmail('jamesmcqmusic@gmail.com', 'Lesson rescheduled: ' + (credit.name || 'a student') + ', ' + date + ' ' + time, jamesHtml);

    return { statusCode: 200, body: JSON.stringify({ success: true, date: date, time: time }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
