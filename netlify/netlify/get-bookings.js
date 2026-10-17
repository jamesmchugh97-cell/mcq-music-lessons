// Netlify serverless function: returns all currently booked lesson slots
// from Netlify Blobs, so the calendar shows real-time availability
// instead of a hardcoded list. Each entry includes its duration so the
// frontend can work out overlaps and minimum gaps correctly.
const { getStore } = require('@netlify/blobs');
// isStalePendingHold (see subscription-helpers.js) excludes abandoned,
// unpaid reservations from what the calendar shows as booked - without
// it, a failed or abandoned checkout would make a genuinely free slot
// look taken to every visitor until someone specifically tries to book
// that exact time and triggers the release elsewhere.
const { isStalePendingHold } = require('./subscription-helpers');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
  try {
    const { blobs } = await store.list();
    const booked = {};
    for (const blob of blobs) {
      const record = await store.get(blob.key, { type: 'json' });
      if (record && record.date && record.time && !isStalePendingHold(record)) {
        if (!booked[record.date]) booked[record.date] = [];
        booked[record.date].push({ time: record.time, duration: record.duration || 45 });
      }
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, booked })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'Failed to load bookings' })
    };
  }
};
