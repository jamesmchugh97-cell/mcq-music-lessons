// Netlify serverless function: reserves one or more lesson slots at once,
// enforcing that no lesson overlaps another and that no booking leaves an
// unusably small gap (under 30 minutes) next to an existing lesson. This
// is the authoritative check — the frontend also filters options for a
// better experience, but this is what actually protects the schedule.
const { getStore } = require('@netlify/blobs');

const MIN_GAP_MINUTES = 30;

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
  const { slots, name, email, duration } = body;
  if (!Array.isArray(slots) || slots.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'No lesson dates provided.' }) };
  }
  for (const s of slots) {
    if (!s || !s.date || !s.time) {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Every lesson needs a date and time.' }) };
    }
  }
  const durationMinutes = parseInt(duration, 10) || 45;

  const store = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });

  try {
    // Group requested slots by date so we only fetch each date's existing bookings once.
    const byDate = {};
    for (const s of slots) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    }

    for (const date in byDate) {
      const { blobs } = await store.list({ prefix: date + '_' });
      const existing = [];
      for (const blob of blobs) {
        const record = await store.get(blob.key, { type: 'json' });
        if (record && record.time) {
          const start = timeToMinutes(record.time);
          existing.push({ time: record.time, duration: record.duration || 45, start: start, end: start + (record.duration || 45) });
        }
      }

      for (const s of byDate[date]) {
        const start = timeToMinutes(s.time);
        const end = start + durationMinutes;
        for (const ex of existing) {
          const overlap = start < ex.end && ex.start < end;
          if (overlap) {
            return {
              statusCode: 200,
              body: JSON.stringify({ success: false, error: s.date + ' at ' + s.time + ' overlaps a lesson already booked at ' + ex.time + '. Please choose a different time.' })
            };
          }
          const gapBefore = start - ex.end;
          const gapAfter = ex.start - end;
          if (gapBefore > 0 && gapBefore < MIN_GAP_MINUTES) {
            return {
              statusCode: 200,
              body: JSON.stringify({ success: false, error: s.date + ' at ' + s.time + ' would leave less than 30 minutes free after the ' + ex.time + ' lesson. Please choose a different time.' })
            };
          }
          if (gapAfter > 0 && gapAfter < MIN_GAP_MINUTES) {
            return {
              statusCode: 200,
              body: JSON.stringify({ success: false, error: s.date + ' at ' + s.time + ' would leave less than 30 minutes free before the ' + ex.time + ' lesson. Please choose a different time.' })
            };
          }
        }
      }

      // Also check the new slots requested on this same date aren't too close to each other.
      const sameDaySlots = byDate[date]
        .map(s => ({ time: s.time, start: timeToMinutes(s.time) }))
        .sort((a, b) => a.start - b.start);
      for (let i = 0; i < sameDaySlots.length - 1; i++) {
        const gap = sameDaySlots[i + 1].start - (sameDaySlots[i].start + durationMinutes);
        if (gap < 0 || (gap > 0 && gap < MIN_GAP_MINUTES)) {
          return {
            statusCode: 200,
            body: JSON.stringify({ success: false, error: 'Two of your chosen lesson times on ' + date + ' are too close together. Leave at least 30 minutes between lessons, or book them back-to-back.' })
          };
        }
      }
    }

    // All clear — reserve every slot, storing its duration so future
    // bookings can be checked against it correctly.
    for (const s of slots) {
      const key = s.date + '_' + s.time;
      await store.setJSON(key, {
        date: s.date,
        time: s.time,
        duration: durationMinutes,
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
