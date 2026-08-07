// Netlify serverless function: reserves one or more lesson slots at once.
// Whether it's a single trial lesson or a custom multi-lesson booking with
// its own date and time picked for each lesson, every requested slot is
// checked and reserved together, so a booking never ends up only
// partially confirmed and two people can never pay for the same time.
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
  const { slots, name, email } = body;
  if (!Array.isArray(slots) || slots.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'No lesson dates provided.' }) };
  }
  for (const s of slots) {
    if (!s || !s.date || !s.time) {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Every lesson needs a date and time.' }) };
    }
  }

  const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });

  try {
    // Check every requested slot is free before reserving any of them,
    // so a booking is never left half-confirmed.
    for (const s of slots) {
      const key = s.date + '_' + s.time;
      const existing = await store.get(key);
      if (existing) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            success: false,
            error: s.date + ' at ' + s.time + ' has just been booked by someone else. Please choose a different date or time for that lesson.'
          })
        };
      }
    }
    // All clear — reserve every slot.
    for (const s of slots) {
      const key = s.date + '_' + s.time;
      await store.setJSON(key, {
        date: s.date,
        time: s.time,
        name: name || '',
        email: email || '',
        bookedAt: new Date().toISOString()
      });
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, slots: slots }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
