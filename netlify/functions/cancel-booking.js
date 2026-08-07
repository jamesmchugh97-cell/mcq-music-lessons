// Netlify serverless function: lets a student cancel their own lesson.
// Verifies the email matches the booking before cancelling (so nobody can
// cancel someone else's lesson), always frees the slot, and emails both
// the student and James so nothing slips through unnoticed. Refunds are
// never issued automatically, a 24+ hour cancellation depends on James
// actually finding a workable makeup time first, so that call stays with
// him via Stripe, not this function.
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

function addOneDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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

    const hoursUntil = (melbourneEpochMs(date, time) - Date.now()) / (1000 * 60 * 60);
    const eligible = hoursUntil >= 24;

    // Friday cancellations with 24+ hours' notice are the one case where
    // there's no weekday left that same week for a makeup, so grant a
    // one-time Saturday makeup credit for the Saturday right after.
    let saturdayGranted = null;
    const isFriday = new Date(date + 'T00:00:00').getDay() === 5;
    if (eligible && isFriday) {
      const satDate = addOneDay(date);
      try {
        const creditsStore = getStore({ name: 'saturday-credits', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
        await creditsStore.setJSON(satDate + '_' + email.trim().toLowerCase(), {
          email: email.trim().toLowerCase(),
          date: satDate,
          originalFriday: date,
          grantedAt: new Date().toISOString()
        });
        saturdayGranted = satDate;
      } catch (e) {}
    }

    // Rebook link: sends the student straight back to the calendar,
    // jumped to the week their cancelled lesson was in, so they can pick
    // a new time themselves without needing to email James. If a
    // Saturday makeup credit was granted, the button points at that
    // Saturday instead, since that's the actual bookable date.
    const rebookDate = saturdayGranted || date;
    const rebookButtonHtml =
      '<p style="text-align:center;margin:24px 0;"><a href="https://mcqmusiclessons.com.au/?rebook=' + rebookDate + '#calendar" style="background:#c9942a;color:#1a1a1a;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:600;display:inline-block;">Rebook a lesson this week &rarr;</a></p>';

    const studentName = record.name || 'there';
    const studentHtml =
      '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">' +
      '<div style="text-align:center;margin-bottom:24px;">' +
      '<p style="font-family:Georgia,\'Times New Roman\',serif;font-size:24px;color:#c9942a;margin:0;">&#9834; MCQ Music</p>' +
      '</div>' +
      '<h2 style="text-align:center;font-family:Georgia,serif;font-weight:normal;">Lesson Cancelled</h2>' +
      '<p>Hi ' + studentName + ',</p>' +
      '<p>Your lesson on <strong>' + date + ' at ' + time + '</strong> has been cancelled as requested.</p>' +
      '<p>' + (eligible
        ? "Since this was cancelled with 24 hours' notice or more, you can rebook a new time this same week yourself using the button below, no need to contact James. Just pick any available slot before the week is out. If you don't rebook, this lesson won't be refunded."
        : "As this was cancelled with less than 24 hours' notice, the full lesson fee applies and no makeup lesson is available.") + '</p>' +
      (saturdayGranted
        ? '<p>Since your usual weekday makeup slots aren\'t available this week, you can book a one-off <strong>Saturday makeup lesson on ' + saturdayGranted + '</strong> using this same email address on the booking page.</p>'
        : '') +
      rebookButtonHtml +
      '<p style="font-size:0.85em;color:#666;">Questions? Reply to this email or call 0499 232 898.</p>' +
      '</div>';
    await sendEmail(email, 'Your lesson has been cancelled', studentHtml);

    const jamesHtml =
      '<div style="font-family:-apple-system,sans-serif;">' +
      '<h3>Lesson cancelled</h3>' +
      '<p><strong>' + studentName + '</strong> (' + email + ') cancelled their lesson on <strong>' + date + ' at ' + time + '</strong>.</p>' +
      '<p>Notice given: ' + hoursUntil.toFixed(1) + ' hours (' + (eligible ? 'eligible for a same-week makeup attempt' : 'within 24 hours \u2014 no makeup, full fee applies') + ').</p>' +
      (saturdayGranted ? '<p>Saturday makeup credit granted for <strong>' + saturdayGranted + '</strong>.</p>' : '') +
      '</div>';
    await sendEmail('jamesmcqmusic@gmail.com', 'Booking cancelled: ' + studentName + ' \u2014 ' + date + ' ' + time, jamesHtml);

    return { statusCode: 200, body: JSON.stringify({ success: true, eligible: eligible, saturdayGranted: saturdayGranted }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
