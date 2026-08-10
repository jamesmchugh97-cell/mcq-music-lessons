// Netlify serverless function: sends a booking confirmation email via Resend.
// Requires a RESEND_API_KEY environment variable to be set in your
// Netlify site settings (Site configuration -> Environment variables).
// Sends from a mcqmusiclessons.com.au address, since that domain is
// verified in Resend.
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
  const { name, email, instrument, date, time, duration, lessons_count, total, slots } = body;
  if (!email || !name) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing name or email.' }) };
  }
  const slotList = Array.isArray(slots) && slots.length > 0 ? slots : [{ date: date, time: time }];
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

  const introLine = isMulti
    ? `<p>You've booked <strong>${lessonsCountNum} lessons</strong>. See the dates below.</p>`
    : `<p>Welcome to your first lesson with MCQ Music! This is your <strong>trial lesson</strong>, a chance to see if it's the right fit. Most students then move to a regular weekly or fortnightly time, the same slot reserved every week. You can <a href="https://mcqmusiclessons.com.au/booking.html#subscribe" style="color:#c9942a;">set that up</a> any time after your lesson.</p>`;

  const emailSubject = isMulti ? 'Your lesson booking is confirmed!' : 'Welcome to your first lesson!';

  // Fortnight self-service policy (matches cancel-booking.js): 24+ hours'
  // notice gives a free single-use rebook link, not a "James finds you a
  // makeup lesson" promise.
  const cancellationNotice = `Cancel with 24+ hours' notice and you'll get a link by email to rebook a new time yourself, any day over the following two weeks, no charge. Cancel with less than 24 hours' notice and the full lesson fee applies with no rebooking available.`;

  const dateFieldsHtml = slotList.length > 1
    ? `<li><strong>Lesson dates:</strong><ul style="margin-top:4px;">${slotList.map(s => `<li>${formatFriendlyDate(s.date)} at ${s.time}</li>`).join('')}</ul></li>`
    : `<li><strong>Date:</strong> ${formatFriendlyDate(slotList[0].date)}</li>
        <li><strong>Time:</strong> ${slotList[0].time || 'N/A'}</li>`;

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
      <p>Hi ${name}, thanks for booking with MCQ Music Lessons. Here are your details:</p>
      <ul>
        <li><strong>Instrument:</strong> ${instrument || 'N/A'}</li>
        ${dateFieldsHtml}
        ${durationMinutes ? `<li><strong>Duration:</strong> ${durationMinutes} minutes</li>` : ''}
        <li><strong>Total:</strong> ${total || 'N/A'}</li>
        <li><strong>Location:</strong> 84 Nelson Road, South Melbourne VIC 3205</li>
      </ul>
      ${introLine}
      <p>Looking forward to our lesson! If you have any questions before then, just reply to this email or call 0499 232 898.</p>
      <p style="font-size: 0.85em; color: #666; border-top: 1px solid #ddd; padding-top: 12px; margin-top: 20px;">
        <strong>Cancellation policy:</strong> ${cancellationNotice}
      </p>
      <p style="text-align:center;margin-top:16px;">
        <a href="https://mcqmusiclessons.com.au/booking.html?manage_email=${encodeURIComponent(email)}#manage" style="color:#c9942a;font-size:0.85em;text-decoration:underline;">Need to cancel this lesson?</a>
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
      <p><strong>${name}</strong> (${email}) booked ${isMulti ? lessonsCountNum + ' lessons' : 'a trial lesson'}.</p>
      <ul>
        <li><strong>Instrument:</strong> ${instrument || 'N/A'}</li>
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
