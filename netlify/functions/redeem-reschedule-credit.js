// Netlify serverless function: redeems a reschedule credit (granted by
// cancel-booking.js when a student cancels with 24+ hours' notice) into an
// actual new booking, with NO payment step, since the student already paid
// for the lesson they cancelled, this only moves it to a new slot. Checks
// the credit is unused, unexpired, and that the chosen date falls inside
// the same week it was granted for, then reserves the slot using the same
// duration-aware overlap check and recurring-student awareness as
// reserve-multi-slots.js (not just an exact-key match), and writes
// atomically so it can never land on top of another lesson.
const { getStore } = require('@netlify/blobs');
const { createCalendarEvent } = require('./google-calendar-helper');
const { listBlockingSubscriptionsForDay, timeToMinutes: subTimeToMinutes } = require('./subscription-helpers');

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

function minutesToIsoClock(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00';
}

// Formats a 'YYYY-MM-DD' date string into something readable in an
// email, e.g. 'Monday, 17 August 2026', instead of showing students the
// raw machine-format date.
function formatFriendlyDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

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

const FRI_SAT_CLOSING_MINUTES = 16 * 60 + 30;
const MON_THU_CLOSING_MINUTES = 21 * 60;

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay();
}

function isWithinBusinessHours(dateStr, startMinutes, endMinutes) {
  const dow = dayOfWeek(dateStr);
  if (dow === 5 || dow === 6) return endMinutes <= FRI_SAT_CLOSING_MINUTES;
  return endMinutes <= MON_THU_CLOSING_MINUTES;
}

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
  } catch (e) {}
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
  const { token, date, time } = body;
  if (!token || !date || !time) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing token, date, or time.' }) };
  }

  const creditsStore = getStore({ name: 'reschedule-credits', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });

  try {
    const credit = await creditsStore.get(token, { type: 'json' });
    if (!credit) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'This reschedule link is invalid. Please contact James directly.' }) };
    }
    if (credit.used) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'This reschedule link has already been used.' }) };
    }
    const todayStr = new Date().toISOString().split('T')[0];
    if (todayStr > credit.weekEnd) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'This reschedule link has expired.' }) };
    }
    if (date < credit.weekStart || date > credit.weekEnd) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Please choose a date within your original lesson\u2019s week.' }) };
    }

    const startMinutes = timeToMinutes(time);
    if (startMinutes === null) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Invalid time format.' }) };
    }
    const duration = credit.duration || 45;
    const endMinutes = startMinutes + duration;
    const dow = dayOfWeek(date);
    if (dow === 0) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'James is closed on Sundays.' }) };
    }
    if (!isWithinBusinessHours(date, startMinutes, endMinutes)) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time runs past closing hours for that day.' }) };
    }
    const hoursUntil = (melbourneEpochMs(date, time) - Date.now()) / (1000 * 60 * 60);
    if (hoursUntil < 24) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time is less than 24 hours away. Please choose a later slot.' }) };
    }

    const bookingsStore = getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });

    const { blobs } = await bookingsStore.list({ prefix: date + '_' });
    const existing = [];
    for (const blob of blobs) {
      const record = await bookingsStore.get(blob.key, { type: 'json' });
      if (record && record.time) {
        const s = timeToMinutes(record.time);
        existing.push({ time: record.time, start: s, end: s + (record.duration || 45) });
      }
    }
    getRecurringBookingsForDate(date).forEach(rb => {
      const s = timeToMinutes(rb.time);
      existing.push({ time: rb.time, start: s, end: s + rb.duration });
    });

    const blockingSubs = await listBlockingSubscriptionsForDay(dow);
    blockingSubs.forEach(sub => {
      const s = subTimeToMinutes(sub.time);
      const dur = parseInt(sub.durationMinutes, 10);
      existing.push({ time: sub.time, start: s, end: s + dur });
    });

    for (const ex of existing) {
      const overlap = startMinutes < ex.end && ex.start < endMinutes;
      if (overlap) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time overlaps a lesson already booked at ' + ex.time + '. Please choose a different time.' }) };
      }
      const gapBefore = startMinutes - ex.end;
      const gapAfter = ex.start - endMinutes;
      if (gapBefore > 0 && gapBefore < MIN_GAP_MINUTES) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time would leave less than 30 minutes free after the ' + ex.time + ' lesson. Please choose a different time.' }) };
      }
      if (gapAfter > 0 && gapAfter < MIN_GAP_MINUTES) {
        return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time would leave less than 30 minutes free before the ' + ex.time + ' lesson. Please choose a different time.' }) };
      }
    }

    const key = date + '_' + time;
    const record = {
      date: date,
      time: time,
      duration: duration,
      name: credit.name,
      email: credit.email,
      rescheduledFrom: credit.originalDate + ' ' + credit.originalTime,
      bookedAt: new Date().toISOString()
    };
    const writeResult = await bookingsStore.set(key, JSON.stringify(record), { onlyIfNew: true });
    if (writeResult && writeResult.modified === false) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'That time was just taken. Please pick a different slot.' }) };
    }

    try {
      const startDateTime = date + 'T' + minutesToIsoClock(startMinutes);
      const endDateTime = date + 'T' + minutesToIsoClock(endMinutes);
      const eventId = await createCalendarEvent({
        studentName: credit.name || 'Student',
        startDateTime: startDateTime,
        endDateTime: endDateTime,
        notes: (credit.instrument ? 'Instrument: ' + credit.instrument + '\n' : '') + (credit.email ? ('Rescheduled by ' + credit.email + ' from ' + credit.originalDate + ' ' + credit.originalTime) : ''),
        instrument: credit.instrument
      });
      if (eventId) {
        record.eventId = eventId;
        await bookingsStore.set(key, JSON.stringify(record));
      }
    } catch (calErr) {
      console.error('Google Calendar event creation failed for rescheduled ' + key + ':', calErr && calErr.message ? calErr.message : calErr);
    }

    credit.used = true;
    await creditsStore.setJSON(token, credit);

    const html =
      '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">' +
      '<div style="text-align:center;margin-bottom:24px;">' +
      '<p style="font-family:Georgia,\'Times New Roman\',serif;font-size:24px;color:#c9942a;margin:0;">&#9834; MCQ Music</p>' +
      '</div>' +
      '<h2 style="text-align:center;font-family:Georgia,serif;font-weight:normal;">Lesson Rescheduled</h2>' +
      '<p>Hi ' + (credit.name || 'there') + ',</p>' +
      '<p>Your lesson is now booked for <strong>' + formatFriendlyDate(date) + ' at ' + time + '</strong>. No payment was needed, this simply moves the lesson you already paid for.</p>' +
      '<p>Lessons are at 84 Nelson Rd, South Melbourne VIC 3205.</p>' +
      '<p style="font-size:0.85em;color:#666;">Questions? Reply to this email or call 0499 232 898.</p>' +
      '<p style="text-align:center;margin-top:16px;">' +
      '<a href="https://mcqmusiclessons.com.au/booking.html?manage_email=' + encodeURIComponent(credit.email) + '#manage" style="color:#c9942a;font-size:0.85em;text-decoration:underline;">Need to cancel this lesson?</a>' +
      '</p>' +
      '</div>';
    await sendEmail(credit.email, 'Your lesson has been rescheduled', html);

    const jamesHtml =
      '<div style="font-family:-apple-system,sans-serif;">' +
      '<h3>Lesson rescheduled (no charge)</h3>' +
      '<p><strong>' + (credit.name || 'A student') + '</strong> (' + credit.email + ') moved their cancelled lesson from <strong>' + formatFriendlyDate(credit.originalDate) + ' ' + credit.originalTime + '</strong> to <strong>' + formatFriendlyDate(date) + ' ' + time + '</strong>, using their reschedule credit. No new payment was taken.</p>' +
      '</div>';
    await sendEmail('jamesmcqmusic@gmail.com', 'Lesson rescheduled: ' + (credit.name || 'a student') + ', ' + date + ' ' + time, jamesHtml);

    return { statusCode: 200, body: JSON.stringify({ success: true, date: date, time: time }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
