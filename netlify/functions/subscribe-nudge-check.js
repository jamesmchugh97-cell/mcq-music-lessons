// subscribe-nudge-check.js
// Netlify scheduled function (runs daily): finds students whose most
// recent one-off lesson has just finished and who aren't already
// subscribed, then sends a one-time "enjoyed your lesson? want a weekly
// slot?" nudge with a link straight into the Subscribe flow. Each email
// address is only ever nudged once (tracked in a small "subscribe-nudges"
// Blobs store, claimed atomically so two overlapping runs can never both
// send it), regardless of how many further one-off lessons that student
// books afterwards. Fully automatic - no manual fit-check or flagging
// step, matching how the rest of the subscription system works.
const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');
const { listAllSubscriptions, escapeHtml } = require('./subscription-helpers');

const LOOKBACK_DAYS = 4; // scan the last few days of bookings so a missed run still catches up
const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

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
// LOCAL wall-clock time into a true UTC epoch timestamp (ms), the same
// DST-safe approach used throughout the rest of the codebase, so "has
// this lesson actually finished yet" is accurate regardless of the
// server's own timezone or the time of year.
function melbourneEpochMs(dateStr, timeStr) {
  const minutes = timeToMinutes(timeStr) || 0;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const hour = Math.floor(minutes / 60);
  const min = minutes % 60;
  const naiveUtcMs = Date.UTC(y, mo - 1, d, hour, min);
  let offsetMinutes = 600;
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
  } catch (e) {
    console.error('[subscribe-nudge-check] email send failed:', e && e.message ? e.message : e);
  }
}

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

function nudgesStore() {
  return getStore({ name: 'subscribe-nudges', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

exports.handler = schedule('@daily', async (event) => {
  try {
    // Anyone with a currently active OR paused subscription should never
    // get this nudge - they're already subscribed. Built once up front
    // rather than re-checked per booking.
    const allSubs = await listAllSubscriptions();
    const subscribedEmails = new Set(
      allSubs
        .filter(s => s.status === 'active' || s.status === 'paused')
        .map(s => (s.studentEmail || '').trim().toLowerCase())
    );

    const bStore = bookingsStore();
    const nStore = nudgesStore();
    const today = new Date();

    for (let i = 0; i < LOOKBACK_DAYS; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = formatDateKey(d);
      const { blobs } = await bStore.list({ prefix: dateStr + '_' });

      for (const blob of blobs) {
        const record = await bStore.get(blob.key, { type: 'json' });
        if (!record || !record.email || !record.time) continue;
        // An unpaid pending hold (abandoned or failed checkout) is not a
        // lesson that happened - nudging "hope you enjoyed your lesson"
        // off the back of one would be embarrassing and confusing.
        if (record.pendingPayment === true) continue;

        // Subscription-generated lessons don't need a nudge - that
        // student is already subscribed by definition.
        if (record.subscriptionId) continue;

        const emailLower = record.email.trim().toLowerCase();
        if (subscribedEmails.has(emailLower)) continue;

        // Only nudge once the lesson has actually finished, not while
        // it's still happening or before it's started.
        const startMs = melbourneEpochMs(dateStr, record.time);
        const endMs = startMs + (record.duration || 45) * 60000;
        if (endMs > Date.now()) continue;

        // Atomically claim this email before sending - if it's already
        // claimed (nudged from this lesson or an earlier one), skip.
        // Claiming first and only sending on a successful claim means
        // two overlapping runs can never both send it.
        const nudgeKey = 'nudge_' + emailLower;
        let claimed = true;
        try {
          const setResult = await nStore.set(nudgeKey, JSON.stringify({ email: record.email, nudgedAt: new Date().toISOString(), fromBooking: blob.key }), { onlyIfNew: true });
          if (setResult && setResult.modified === false) claimed = false;
        } catch (e) {
          claimed = false;
        }
        if (!claimed) continue;

        const studentName = record.name || 'there';
        const html =
          '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">' +
          '<div style="text-align:center;margin-bottom:24px;">' +
          '<p style="font-family:Georgia,\'Times New Roman\',serif;font-size:24px;color:#c9942a;margin:0;">&#9834; MCQ Music</p>' +
          '</div>' +
          '<h2 style="text-align:center;font-family:Georgia,serif;font-weight:normal;">How was your lesson?</h2>' +
          '<p>Hi ' + escapeHtml(studentName) + ',</p>' +
          '<p>Hope you enjoyed your' + (record.instrument ? ' ' + escapeHtml(record.instrument.toLowerCase()) : '') + ' lesson. If you\'d like to keep going, you can lock in the same time every week or fortnight and skip paying lesson by lesson.</p>' +
          '<p style="text-align:center;margin:24px 0;"><a href="https://mcqmusiclessons.com.au/booking.html#subscribe" style="background:#c9942a;color:#1a1a1a;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:600;display:inline-block;">Set up a weekly slot &rarr;</a></p>' +
          '<p style="font-size:0.85em;color:#666;">No pressure, this is just here if you\'d like it. You can keep booking one lesson at a time instead, any time from the booking page. Questions? Reply to this email or call 0499 232 898.</p>' +
          '</div>';

        await sendEmail(record.email, 'MCQ Music Lessons: want a weekly slot?', html);
        await sendEmail(
          JAMES_EMAIL,
          'Subscribe nudge sent: ' + studentName,
          '<p>A "want a weekly slot?" nudge was just sent to <strong>' + escapeHtml(studentName) + '</strong> (' + escapeHtml(record.email) + ') after their lesson on ' + dateStr + ' at ' + record.time + '.</p>'
        );
      }
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[subscribe-nudge-check] handler error:', err && err.message ? err.message : err);
    return { statusCode: 200, body: 'ok' };
  }
});
