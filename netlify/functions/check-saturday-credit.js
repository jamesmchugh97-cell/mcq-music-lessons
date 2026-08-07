// Netlify serverless function: checks whether a given email has a valid
// Saturday makeup credit for a specific date. Credits are granted
// automatically by cancel-booking.js when a Friday lesson is cancelled
// with 24+ hours' notice, since Saturday is the only day left that week
// for a makeup. This is what actually gates Saturday bookings — Saturday
// is closed to everyone else by default.
const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  const email = ((event.queryStringParameters && event.queryStringParameters.email) || '').trim().toLowerCase();
  const date = ((event.queryStringParameters && event.queryStringParameters.date) || '').trim();
  if (!email || !date) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Email and date are required.' }) };
  }

  const store = getStore({ name: 'saturday-credits', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });

  try {
    const key = date + '_' + email;
    const record = await store.get(key, { type: 'json' });
    return { statusCode: 200, body: JSON.stringify({ success: true, eligible: !!record }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Failed to check eligibility.' }) };
  }
};
