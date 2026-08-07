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

  const introLine = isMulti
    ? `<p>You've booked <strong>${lessonsCountNum} lessons</strong>. See the dates below.</p>`
    : `<p>This is your <strong>trial lesson</strong>, a chance to see if it's the right fit before you commit.</p>`;
  const cancellationNotice = `Cancel with 24+ hours' notice and I'll do my best to find a makeup lesson within that same week. If we can't, it's not refunded. Cancel with less than 24 hours' notice and the full lesson fee applies with no makeup available.`;

  const dateFieldsHtml = slotList.length > 1
    ? `<li><strong>Lesson dates:</strong><ul style="margin-top:4px;">${slotList.map(s => `<li>${s.date} at ${s.time}</li>`).join('')}</ul></li>`
    : `<li><strong>Date:</strong> ${slotList[0].date || 'N/A'}</li>
        <li><strong>Time:</strong> ${slotList[0].time || 'N/A'}</li>`;

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
        ${dateFieldsHtml}
        ${durationMinutes ? `<li><strong>Duration:</strong> ${durationMinutes} minutes</li>` : ''}
        <li><strong>Total:</strong> ${total || 'N/A'}</li>
      </ul>
      ${introLine}
      <p>James will be in touch within 24 hours to confirm.</p>
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
