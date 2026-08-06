// Netlify serverless function: checks and reserves a lesson time slot
// using Netlify Blobs, so slots can never be double-booked.
// No environment variables needed — Netlify Blobs works automatically.

const { getStore } = require('@netlify/blobs');

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

  const { date, time, name, email } = body;

  if (!date || !time) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing date or time.' }) };
  }

  const store = getStore('bookings');
  const key = date + '_' + time;

  try {
    const existing = await store.get(key);
    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time slot has just been booked by someone else. Please choose a different time.' }) };
    }

    await store.setJSON(key, { date, time, name: name || '', email: email || '', bookedAt: new Date().toISOString() });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
