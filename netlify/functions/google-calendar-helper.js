// google-calendar-helper.js
// Handles Google Calendar authentication and event create/delete
// for MCQ Music Lessons booking system.

const { google } = require('googleapis');

const CALENDAR_ID = '2ff935679048c69b28ae7cd558a13f04fd48cc736cf56d524912afc52eae06dd@group.calendar.google.com';

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

async function createCalendarEvent({ studentName, startDateTime, endDateTime, notes }) {
  console.log('[calendar-helper] createCalendarEvent called for', studentName, startDateTime, '-', endDateTime);
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const event = {
    summary: `Lesson: ${studentName}`,
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
}

async function deleteCalendarEvent(eventId) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.events.delete({
    calendarId: CALENDAR_ID,
    eventId: eventId,
  });
}

module.exports = {
  createCalendarEvent,
  deleteCalendarEvent,
};
