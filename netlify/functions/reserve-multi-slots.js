// Netlify serverless function: reserves one or more lesson slots at once,
// enforcing that no lesson overlaps another and that no booking leaves an
// unusably small gap (under 30 minutes) next to an existing lesson. This
// is the authoritative check, the frontend also filters options for a
// better experience, but this is what actually protects the schedule.
// Saturday is a normal open day (Fri/Sat closing hours are enforced below
// via isWithinBusinessHours) — the old Friday-makeup-only restriction and
// its saturday-credits gate have been retired.
const { getStore } = require('@netlify/blobs');
const { createCalendarEvent } = require('./google-calendar-helper');

const MIN_GAP_MINUTES = 30;
const MIN_NOTICE_HOURS = 24;

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

// Converts minutes-since-midnight into a zero-padded "HH:MM:SS" string for
// building a local (timezone-naive) ISO datetime that Google Calendar will
// interpret using the timeZone field passed alongside it.
function minutesToIsoClock(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00';
}

// Converts a date ('YYYY-MM-DD') and time ('3:00 pm') given as Melbourne
// LOCAL wall-clock time into a true UTC epoch timestamp (ms), correctly
// accounting for daylight saving. Netlify's servers run in UTC, so naive
// Date parsing here would otherwise be off by 10-11 hours from what
// Melbourne actually experiences, this keeps the 24-hour notice rules
// accurate regardless of what timezone the server happens to run in.
function melbourneEpochMs(dateStr, timeStr) {
  const minutes = timeToMinutes(timeStr) || 0;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const hour = Math.floor(minutes / 60);
  const min = minutes % 60;
  const naiveUtcMs = Date.UTC(y, mo - 1, d, hour, min);
  let offsetMinutes = 600; // fallback: AEST, UTC+10:00
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

function hoursUntilSlot(dateStr, timeStr) {
  return (melbourneEpochMs(dateStr, timeStr) - Date.now()) / (1000 * 60 * 60);
}

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay();
}

const FRI_SAT_CLOSING_MINUTES = 16 * 60 + 30; // 4:30 pm, lessons must FINISH by this on Fri/Sat
const MON_THU_CLOSING_MINUTES = 21 * 60; // 9:00 pm, lessons must FINISH by this on Mon-Thu

// Mon-Thu: a lesson must finish by 9pm. Fri/Sat: a lesson must finish by
// 4:30pm, so the last bookable start time shifts earlier depending on
// how long the lesson runs.
function isWithinBusinessHours(dateStr, startMinutes, endMinutes) {
  const dow = dayOfWeek(dateStr);
  if (dow === 5 || dow === 6) return endMinutes <= FRI_SAT_CLOSING_MINUTES;
  return endMinutes <= MON_THU_CLOSING_MINUTES;
}

// Victorian government school holiday date ranges (inclusive), per the
// official VIC DET term calendar as of Aug 2026. This list, and the
// RECURRING_STUDENTS roster below, must be kept in sync with the same
// lists in index.html, since this is the server side authoritative check
// and index.html only controls what the booking page displays.
const SCHOOL_HOLIDAY_RANGES = [
  ['2026-09-19', '2026-10-04'],
  ['2026-12-19', '2027-01-26']
];

function isSchoolHoliday(dateStr) {
  return SCHOOL_HOLIDAY_RANGES.some(([start, end]) => dateStr >= start && dateStr <= end);
}

const RECURRING_STUDENTS = [
  { name: 'Meja',    dow: 1, time: '4:00 pm', duration: 75, frequency: 'weekly',      pauseForHolidays: true  },
  { name: 'Nick',    dow: 1, time: '6:00 pm', duration: 90, frequency: 'weekly',      pauseForHolidays: false },
  { name: 'Jacq',    dow: 2, time: '2:30 pm', duration: 60, frequency: 'fortnightly', anchorDate: '2026-08-18', pauseForHolidays: false },
  { name: 'Cash',    dow: 2, time: '4:45 pm', duration: 45, frequency: 'weekly',      pauseForHolidays: true  },
  { name: 'Angus',   dow: 2, time: '5:30 pm', duration: 30, frequency: 'weekly',      pauseForHolidays: true  },
  { name: 'Maria',   dow: 2, time: '6:00 pm', duration: 60, frequency: 'weekly',      pauseForHolidays: true  },
  { name: 'Emma',    dow: 2, time: '7:15 pm', duration: 60, frequency: 'weekly',      pauseForHolidays: false },
  { name: 'Tilly',   dow: 2, time: '8:15 pm', duration: 60, frequency: 'fortnightly', anchorDate: '2026-08-11', pauseForHolidays: false },
  { name: 'Michael', dow: 3, time: '1:00 pm', duration: 60, frequency: 'weekly',      pauseForHolidays: false },
  { name: 'Jacq',    dow: 3, time: '2:00 pm', duration: 90, frequency: 'weekly',      pauseForHolidays: false },
  { name: 'Hugo',    dow: 3, time: '3:45 pm', duration: 45, frequency: 'weekly',      pauseForHolidays: true  },
  { name: 'Anya',    dow: 3, time: '5:15 pm', duration: 30, frequency: 'weekly',      pauseForHolidays: true  },
  { name: 'Alex',    dow: 3, time: '6:00 pm', duration: 60, frequency: 'weekly',      pauseForHolidays: false },
  { name: 'Shannon', dow: 3, time: '7:15 pm', duration: 60, frequency: 'weekly',      pauseForHolidays: false },
  { name: 'Cash',    dow: 4, time: '3:45 pm', duration: 45, frequency: 'weekly',      pauseForHolidays: true  },
  { name: 'Meja',    dow: 4, time: '4:30 pm', duration: 75, frequency: 'weekly',      pauseForHolidays: true  },
  { name: 'Odie',    dow: 4, time: '6:15 pm', duration: 30, frequency: 'weekly',      pauseForHolidays: true  },
  { name: 'Javin',   dow: 4, time: '6:45 pm', duration: 60, frequency: 'weekly',      pauseForHolidays: true  }
];

function isStudentBookedOnDate(student, dateStr) {
  if (dayOfWeek(dateStr) !== student.dow) return false;
  if (student.pauseForHolidays && isSchoolHoliday(dateStr)) return false;
  if (student.frequency === 'weekly') return true;
  if (student.frequency === 'fortnightly' && student.anchorDate) {
    const d = new Date(dateStr + 'T00:00:00');
    const anchor = new Date(student.anchorDate + 'T00:00:00');
    const diffDays = Math.round((d - anchor) / 86400000);
    return ((diffDays % 14) + 14) % 14 === 0;
  }
  return false;
}

function getRecurringBookingsForDate(dateStr) {
  return RECURRING_STUDENTS.filter(s => isStudentBookedOnDate(s, dateStr)).map(s => ({ time: s.time, duration: s.duration }));
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
  const emailLower = (email || '').trim().toLowerCase();

  try {
    // Group requested slots by date so we only fetch each date's existing bookings once.
    const byDate = {};
    for (const s of slots) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    }

    for (const date in byDate) {
      const dow = dayOfWeek(date);
      if (dow === 0) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: date + ' is a Sunday, James is closed. Please choose a different date.' }) };
      }
      const { blobs } = await store.list({ prefix: date + '_' });
      const existing = [];
      for (const blob of blobs) {
        const record = await store.get(blob.key, { type: 'json' });
        if (record && record.time) {
          const start = timeToMinutes(record.time);
          existing.push({ time: record.time, duration: record.duration || 45, start: start, end: start + (record.duration || 45) });
        }
      }
      // Recurring students aren't stored in Blobs, so they're never
      // otherwise visible to this check. Merge them in here so an online
      // booking can never land on top of one of James's regular students.
      getRecurringBookingsForDate(date).forEach(rb => {
        const start = timeToMinutes(rb.time);
        existing.push({ time: rb.time, duration: rb.duration, start: start, end: start + rb.duration });
      });

      for (const s of byDate[date]) {
        const start = timeToMinutes(s.time);
        const end = start + durationMinutes;
        if (!isWithinBusinessHours(s.date, start, end)) {
          return {
            statusCode: 200,
            body: JSON.stringify({ success: false, error: s.date + ' at ' + s.time + ' is outside business hours for that day. Please choose a different time.' })
          };
        }
        if (hoursUntilSlot(s.date, s.time) < MIN_NOTICE_HOURS) {
          return {
            statusCode: 200,
            body: JSON.stringify({ success: false, error: s.date + ' at ' + s.time + ' is less than 24 hours away. Bookings need at least 24 hours\' notice.' })
          };
        }
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

    // Reserve every slot using an atomic "only if new" write, so if two
    // people request the exact same slot in the same instant, only one
    // of them can actually claim it, the other gets a clean rejection
    // instead of silently overwriting the first booking. If any slot in
    // this request loses that race, roll back everything already written
    // so the booking never ends up half-confirmed.
    const written = [];
    for (const s of slots) {
      const key = s.date + '_' + s.time;
      const record = {
        date: s.date,
        time: s.time,
        duration: durationMinutes,
        name: name || '',
        email: email || '',
        bookedAt: new Date().toISOString()
      };
      let claimed = true;
      try {
        const result = await store.set(key, JSON.stringify(record), { onlyIfNew: true });
        if (result && result.modified === false) claimed = false;
      } catch (writeErr) {
        claimed = false;
      }
      if (!claimed) {
        for (const k of written) {
          try { await store.delete(k); } catch (e) {}
        }
        return {
          statusCode: 200,
          body: JSON.stringify({ success: false, error: s.date + ' at ' + s.time + ' was just booked by someone else a moment ago. Please pick a different time and try again.' })
        };
      }
      written.push(key);

      // Create the matching Google Calendar event now that the slot is
      // safely claimed. This is best-effort: if Google's API is down or
      // misconfigured, the booking itself must still succeed, so any
      // failure here is swallowed rather than rolling back the booking.
      // The returned eventId is saved back onto the same blob record so
      // cancel-booking.js can look it up later to delete the event.
      try {
        const startMinutes = timeToMinutes(s.time);
        const endMinutes = startMinutes + durationMinutes;
        const startDateTime = s.date + 'T' + minutesToIsoClock(startMinutes);
        const endDateTime = s.date + 'T' + minutesToIsoClock(endMinutes);
        const eventId = await createCalendarEvent({
          studentName: name || 'Student',
          startDateTime: startDateTime,
          endDateTime: endDateTime,
          notes: email ? ('Booked by ' + email) : ''
        });
        if (eventId) {
          record.eventId = eventId;
          await store.set(key, JSON.stringify(record));
        }
      } catch (calErr) {
        // Booking still stands even if calendar sync fails — but log it
        // visibly so failures show up in Netlify's function logs instead
        // of vanishing silently.
        console.error('Google Calendar event creation failed for ' + key + ':', calErr && calErr.message ? calErr.message : calErr);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, slots: slots }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
