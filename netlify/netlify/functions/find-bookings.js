// Netlify serverless function: looks up all upcoming lessons booked under
// a given email address, so a student can find and manage their own
// bookings, no login system, just an email match against the booking
// records already stored in Netlify Blobs.
const { getStore } = require('@netlify/blobs');

// Times are stored as 12-hour strings like '3:00 pm' or '10:00 am',
// zero-padding is not guaranteed, so plain text sorting ('10:00 am'
// sorts before '9:00 am' as text) gets the order wrong whenever a
// student has more than one lesson on the same date. Converting to
// minutes-since-midnight first sorts by actual time of day instead.
function timeToMinutes(t) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  const email = ((event.queryStringParameters && event.queryStringParameters.email) || '').trim().toLowerCase();
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Email is required.' }) };
  }
  const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
  try {
    const { blobs } = await store.list();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const bookings = [];
    for (const blob of blobs) {
      const record = await store.get(blob.key, { type: 'json' });
      if (record && record.email && record.email.trim().toLowerCase() === email && record.date && record.pendingPayment !== true) {
        const d = new Date(record.date + 'T00:00:00');
        if (d >= today) {
          bookings.push({ date: record.date, time: record.time, duration: record.duration || 45, alreadyRescheduled: !!record.rescheduledFrom });
        }
      }
    }
    bookings.sort((a, b) => (a.date + String(timeToMinutes(a.time)).padStart(4, '0')).localeCompare(b.date + String(timeToMinutes(b.time)).padStart(4, '0')));
    return { statusCode: 200, body: JSON.stringify({ success: true, bookings: bookings }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Failed to look up bookings.' }) };
  }
};
