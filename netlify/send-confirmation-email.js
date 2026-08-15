// Netlify serverless function: sends a booking confirmation email via Resend.
// Requires a RESEND_API_KEY environment variable to be set in your
// Netlify site settings (Site configuration -> Environment variables).
// Sends from a mcqmusiclessons.com.au address, since that domain is
// verified in Resend.
//
// SECURITY: this is a public endpoint - it's called by the booking
// page's own JavaScript, but nothing stops anyone else from calling it
// directly with fabricated details, since it used to trust everything
// in the request body outright. It doesn't create a booking (that
// already happened earlier, via reserve-multi-slots.js and payment),
// it only notifies about one - so this now checks a real, confirmed
// (non-pending) booking record genuinely exists for every claimed slot
// before sending anything. Otherwise this could be used to send fake
// "booking confirmed" emails to any address, or worse, flood James's
// own inbox with fabricated "New booking" notifications carrying
// invented names, dates, and amounts - which risks him becoming numb
// to real ones over time.
const { getStore } = require('@netlify/blobs');
function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

// Nothing here escaped user-supplied text before embedding it in HTML
// emails - a crafted name field could inject a fake link or misleading
// content into an email sent from this site's own trusted domain.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

exports.handler = async function (event) {
  // One-off booking has been fully retired - see reserve-multi-slots.js
  // for the full reasoning. This only ever sent confirmation emails for
  // a one-off booking; its one caller in booking.html no longer runs
  // either, but this closes the endpoint itself too, not just the path
  // to reach it.
  return { statusCode: 200, body: JSON.stringify({ success: false, error: 'One-off bookings are no longer available. Please subscribe instead.' }) };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body' }) };
  }
  const { name, email, instrument, guitar_type, date, time, duration, lessons_count, total, slots } = body;
  // Escaped once here, used everywhere below - name and instrument are
  // free-text fields a student fills in, and get embedded directly into
  // HTML emails to both the student and James.
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeInstrument = escapeHtml(instrument);
  const safeGuitarType = escapeHtml(guitar_type);
  // "Either / Both" isn't worth stating in the email, same reasoning as
  // the calendar event title - it doesn't narrow anything down.
  const displayInstrument = (safeGuitarType && safeGuitarType !== 'Either' && instrument !== 'Piano')
    ? safeInstrument + ' (' + safeGuitarType + ')'
    : safeInstrument;
  if (!email || !name) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing name or email.' }) };
  }
  const slotList = Array.isArray(slots) && slots.length > 0 ? slots : [{ date: date, time: time }];

  // Every claimed slot must be a real, confirmed booking under this
  // same email before any email goes out.
  const store = bookingsStore();
  const emailLower = email.trim().toLowerCase();
  for (const s of slotList) {
    if (!s || !s.date || !s.time) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Could not verify this booking.' }) };
    }
    const record = await store.get(s.date + '_' + s.time, { type: 'json' });
    const recordEmail = (record && record.email || '').trim().toLowerCase();
    if (!record || record.pendingPayment === true || recordEmail !== emailLower) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Could not verify this booking.' }) };
    }
  }

  const lessonsCountNum = parseInt(lessons_count, 10) || slotList.length;
  const isMulti = lessonsCountNum > 1;
  const durationMinutes = duration ? String(duration).split('|')[0] : '';

  // Formats a 'YYYY-MM-DD' date string into something readable in an
  // email, e.g. 'Monday, 17 August 2026', instead of showing students
  // the raw machine-format date. Falls back to the raw string if the
  // date is missing or malformed rather than showing "Invalid Date".
  function formatFriendlyDate(dateStr) {
    if (!dateStr) return 'N/A';
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Builds a one-click "add to your own calendar" link, separate from
  // the Google Calendar sync James's own bookings calendar already has.
  // ctz=Australia/Melbourne means Google handles daylight saving itself.
  function timeToMinutesForCal(t) {
    const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = m[3].toLowerCase();
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h * 60 + min;
  }
  function buildGoogleCalendarLink(title, dateStr, timeStr, durationMinutes) {
    const startMin = timeToMinutesForCal(timeStr);
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
      ctz: 'Australia/Melbourne'
    });
    return 'https://calendar.google.com/calendar/render?' + params.toString();
  }

  const introLine = isMulti
    ? `<p>You've booked <strong>${lessonsCountNum} lessons</strong>. See the dates below.</p>`
    : `<p>Welcome to your first lesson with MCQ Music! This is your <strong>trial lesson</strong>, a chance to see if it's the right fit. Most students then move to a regular weekly or fortnightly time, the same slot reserved every week. You can <a href="https://mcqmusiclessons.com.au/booking.html#subscribe" style="color:#c9942a;">set that up</a> any time after your lesson.</p>`;

  const emailSubject = isMulti ? 'Your lesson booking is confirmed!' : 'Welcome to your first lesson!';

  // Fortnight self-service policy (matches cancel-booking.js): 24+ hours'
  // notice gives a free single-use rebook link, not a "James finds you a
  // makeup lesson" promise.
  const cancellationNotice = `Can't make it? With 24+ hours' notice, cancel from the link below and you'll get a link by email to reschedule to a new time yourself, any day over the following two weeks, no charge. Cancelling with less than 24 hours' notice means the full lesson fee applies and rescheduling isn't available.`;

  const dateFieldsHtml = slotList.length > 1
    ? `<li><strong>Lesson dates:</strong><ul style="margin-top:4px;">${slotList.map(s => `<li>${formatFriendlyDate(s.date)} at ${s.time}</li>`).join('')}</ul></li>`
    : `<li><strong>Date:</strong> ${formatFriendlyDate(slotList[0].date)}</li>
        <li><strong>Time:</strong> ${slotList[0].time || 'N/A'}</li>`;

  const gcalLink = !isMulti ? buildGoogleCalendarLink((instrument || 'Music') + ' Lesson - MCQ Music', slotList[0].date, slotList[0].time, durationMinutes) : null;
  const gcalLinkHtml = gcalLink
    ? `<p style="text-align:center;margin-top:12px;"><a href="${gcalLink}" style="color:#c9942a;font-size:0.85em;text-decoration:underline;">Add to Google Calendar</a></p>`
    : '';

  // Order matters here: duration, total, and address are placed
  // immediately after the greeting, before the longer policy text below,
  // since some email clients (Gmail included) can clip long transactional
  // emails and hide anything that comes after the clip point.
  const emailHtml = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <div style="text-align: center; margin-bottom: 24px;">
        <p style="font-family: Georgia, 'Times New Roman', serif; font-size: 24px; color: #c9942a; margin: 0; letter-spacing: 0.5px;">
          ♪ MCQ Music
        </p>
      </div>
      <h2 style="color: #1a1a1a; text-align: center; font-family: Georgia, serif; font-weight: normal;">Booking Confirmed</h2>
      <p>Hi ${safeName}, thanks for booking with MCQ Music Lessons. Here are your details:</p>
      <ul>
        <li><strong>Instrument:</strong> ${displayInstrument || 'N/A'}</li>
        ${dateFieldsHtml}
        ${durationMinutes ? `<li><strong>Duration:</strong> ${durationMinutes} minutes</li>` : ''}
        <li><strong>Total:</strong> ${total || 'N/A'}</li>
        <li><strong>Location:</strong> 84 Nelson Road, South Melbourne VIC 3205</li>
      </ul>
      ${gcalLinkHtml}
      ${introLine}
      <p>Looking forward to our lesson! If you have any questions before then, just reply to this email or call 0499 232 898.</p>
      <p style="font-size: 0.85em; color: #666; border-top: 1px solid #ddd; padding-top: 12px; margin-top: 20px;">
        <strong>Need to reschedule or cancel?</strong> ${cancellationNotice}
      </p>
      <p style="text-align:center;margin-top:16px;">
        <a href="https://mcqmusiclessons.com.au/booking.html?manage_email=${encodeURIComponent(email)}#manage" style="color:#c9942a;font-size:0.85em;text-decoration:underline;">Reschedule or cancel this lesson</a>
      </p>
    </div>
  `;

  // Separate, plainer notification to James himself so he knows a lesson
  // was booked without digging through Resend logs or the site's own
  // booking storage. Sent as a second, independent request so a failure
  // here never blocks the student's own confirmation from going out.
  const jamesHtml = `
    <div style="font-family: -apple-system, sans-serif;">
      <h3>New booking</h3>
      <p><strong>${safeName}</strong> (${safeEmail}) booked ${isMulti ? lessonsCountNum + ' lessons' : 'a trial lesson'}.</p>
      <ul>
        <li><strong>Instrument:</strong> ${displayInstrument || 'N/A'}</li>
        ${dateFieldsHtml}
        ${durationMinutes ? `<li><strong>Duration:</strong> ${durationMinutes} minutes</li>` : ''}
        <li><strong>Total:</strong> ${total || 'N/A'}</li>
      </ul>
    </div>
  `;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>',
        to: [email],
        subject: emailSubject,
        html: emailHtml
      })
    });
    const result = await resp.json();

    // Fire-and-forget: don't let a failure here affect the response the
    // student-facing booking flow relies on.
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>',
          to: ['jamesmcqmusic@gmail.com'],
          subject: 'New booking: ' + name + (isMulti ? ' (' + lessonsCountNum + ' lessons)' : ''),
          html: jamesHtml
        })
      });
    } catch (notifyErr) {}

    if (!resp.ok) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: result.message || 'Failed to send email.' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, id: result.id }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
