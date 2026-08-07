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
  const { name, email, instrument, date, time, duration, lessons_count, frequency, total } = body;
  if (!email || !name) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing name or email.' }) };
  }
  const lessons = parseInt(lessons_count, 10) || 1;
  const isTerm = lessons > 1;
  const durationMinutes = duration ? String(duration).split('|')[0] : '';
  const termLine = isTerm
    ? `<p>This is a <strong>${lessons}-lesson term</strong>, delivered <strong>${frequency || 'weekly'}</strong>.</p>`
    : `<p>This is your <strong>trial lesson</strong> — a chance to see if it's the right fit before you commit.</p>`;
  const cancellationNotice = isTerm
    ? `Term fees are non-refundable, but never lost. Give at least 24 hours' notice to reschedule a single lesson, or if you can't finish the term, your remaining lessons carry forward to your current or next enrolled term. See the full cancellation policy on the booking page for details.`
    : `If you need to reschedule, just give at least 24 hours' notice.`;
  const emailHtml = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <div style="text-align: center; margin-bottom: 24px;">
        <p style="font-family: Georgia, 'Times New Roman', serif; font-size: 24px; color: #c9942a; margin: 0; letter-spacing: 0.5px;">
          ♪ MCQ Music
        </p>
      </div>
      <h2 style="color: #1a1a1a; text-align: center; font-family: Georgia, serif; font-weight: normal;">Booking Confirmed</h2>
      <p>Hi ${name},</p>
      <p>Thanks for booking with MCQ Music Lessons! Here are your details:</p>
      <ul>
        <li><strong>Instrument:</strong> ${instrument || 'N/A'}</li>
        <li><strong>Date:</strong> ${date || 'N/A'}</li>
        <li><strong>Time:</strong> ${time || 'N/A'}</li>
        ${durationMinutes ? `<li><strong>Duration:</strong> ${durationMinutes} minutes</li>` : ''}
        <li><strong>Total:</strong> ${total || 'N/A'}</li>
      </ul>
      ${termLine}
      <p>James will be in touch within 24 hours to confirm your time.</p>
      <p style="font-size: 0.85em; color: #666; border-top: 1px solid #ddd; padding-top: 12px; margin-top: 20px;">
        <strong>Cancellation policy:</strong> ${cancellationNotice}
      </p>
      <p style="font-size: 0.85em; color: #666;">
        Questions? Reply to this email or call 0499 232 898.
      </p>
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
        subject: 'Your lesson booking is confirmed!',
        html: emailHtml
      })
    });
    const result = await resp.json();
    if (!resp.ok) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: result.message || 'Failed to send email.' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, id: result.id }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
