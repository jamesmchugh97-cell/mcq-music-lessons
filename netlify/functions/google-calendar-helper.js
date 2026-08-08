// google-calendar-helper.js
// Handles Google Calendar authentication and event create/delete
// for MCQ Music Lessons booking system.

const { google } = require('googleapis');

const CALENDAR_ID = '8aff17od18cc197e7f39ff0cda5ea1f6407fc354dc5d14359158a5bd4655ecd8@group.calendar.google.com';

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  return new google.auth.JWT(
    email,
    null,
    key,
    ['https://www.googleapis.com/auth/calendar']
  );
}

async function createCalendarEvent({ studentName, startDateTime, endDateTime, notes }) {
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
