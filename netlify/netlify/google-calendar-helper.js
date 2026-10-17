// google-calendar-helper.js
// Handles Google Calendar authentication and event create/delete
// for MCQ Music Lessons booking system.
const { google } = require('googleapis');
const CALENDAR_ID = '8aff170d18cc197e7f39ff0cda5ea1f6407fc354dc5d14359158a5bd4655ecd8@group.calendar.google.com';

// A failed calendar CREATE is a silent gap - nothing else in the
// system would ever notice or flag it, since the booking/subscription
// itself is already correctly saved regardless (calendar sync is
// deliberately best-effort so a Google outage can never block an
// actual booking). One retry after a brief pause catches most
// transient failures (a momentary network blip, a brief rate limit)
// without meaningfully delaying the caller, cutting down - though not
// eliminating - how often a single hiccup turns into a lesson that
// never shows up on the calendar at all.
async function withRetry(fn, attempts) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        console.log('[calendar-helper] attempt ' + (i + 1) + ' failed, retrying:', e && e.message ? e.message : e);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  throw lastErr;
}

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  const key = rawKey ? rawKey.replace(/\\n/g, '\n') : rawKey;
  // Safe diagnostics: shape-check only, never log the actual key value.
  console.log('[calendar-helper] GOOGLE_SERVICE_ACCOUNT_EMAIL present:', !!email, email ? '(' + email + ')' : '');
  console.log('[calendar-helper] GOOGLE_PRIVATE_KEY present:', !!rawKey, 'length:', rawKey ? rawKey.length : 0);
  console.log('[calendar-helper] key starts correctly:', !!key && key.startsWith('-----BEGIN PRIVATE KEY-----'));
  console.log('[calendar-helper] key ends correctly:', !!key && key.trim().endsWith('-----END PRIVATE KEY-----'));
  return new google.auth.JWT(
    email,
    null,
    key,
    ['https://www.googleapis.com/auth/calendar']
  );
}
async function createCalendarEvent({ studentName, startDateTime, endDateTime, notes, instrument }) {
  console.log('[calendar-helper] createCalendarEvent called for', studentName, startDateTime, '-', endDateTime);
  return await withRetry(async () => {
    const auth = getAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const event = {
      summary: instrument ? `${instrument}: ${studentName}` : `Lesson: ${studentName}`,
      description: notes || '',
      start: {
        dateTime: startDateTime, // ISO string, e.g. 2026-08-10T15:00:00+10:00
        timeZone: 'Australia/Melbourne',
      },
      end: {
        dateTime: endDateTime,
        timeZone: 'Australia/Melbourne',
      },
    };
    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });
    console.log('[calendar-helper] event created, id:', response.data.id);
    return response.data.id; // save this eventId against the booking
  }, 2);
}
async function deleteCalendarEvent(eventId) {
  console.log('[calendar-helper] deleteCalendarEvent called for eventId:', eventId);
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({
    calendarId: CALENDAR_ID,
    eventId: eventId,
  });
  console.log('[calendar-helper] event deleted successfully:', eventId);
}
module.exports = {
  createCalendarEvent,
  deleteCalendarEvent,
};
