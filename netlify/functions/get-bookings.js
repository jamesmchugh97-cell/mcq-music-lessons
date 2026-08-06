// Netlify serverless function: returns all currently booked lesson slots
// from Netlify Blobs, so the calendar shows real-time availability
// instead of a hardcoded list.

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  const store = getStore('bookings');

  try {
    const { blobs } = await store.list();
    const booked = {};

    for (const blob of blobs) {
      const record = await store.get(blob.key, { type: 'json' });
      if (record && record.date && record.time) {
        if (!booked[record.date]) booked[record.date] = [];
        booked[record.date].push(record.time);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, booked })
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
