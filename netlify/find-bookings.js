// Netlify serverless function: looks up all upcoming lessons booked under
// a given email address, so a student can find and manage their own
// bookings, no login system, just an email match against the booking
// records already stored in Netlify Blobs.
const { getStore } = require('@netlify/blobs');
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
    bookings.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    return { statusCode: 200, body: JSON.stringify({ success: true, bookings: bookings }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Failed to look up bookings.' }) };
  }
};
