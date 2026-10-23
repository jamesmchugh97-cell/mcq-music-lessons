// roster.js
// The ONE place James's regular students (the ones not enrolled through the website) are listed on
// the server. Every function that needs them reads from here: one-off booking clashes, enrolment
// clashes, reschedule credits, the admin lists and group classes.
//   dow: 0=Sun..6=Sat. frequency 'weekly' or 'fortnightly'. pauseForHolidays: skipped in VIC school
//   holidays. age: 'child' (under 13), 'teen' (13 to 17) or 'adult' (18 and over).
// The booking page (booking.html) has its own copy of the times, so when someone is added or changed
// here, change RECURRING_STUDENTS in booking.html to match.
const ROSTER = [
  { name: 'Meja', dow: 1, time: '4:00 pm', duration: 75, frequency: 'weekly', pauseForHolidays: true, age: 'child', instrument: 'Guitar', level: 'Intermediate' },
  { name: 'Nick', dow: 1, time: '6:00 pm', duration: 90, frequency: 'weekly', pauseForHolidays: false, age: 'adult', instrument: 'Guitar', level: 'Intermediate' },
  { name: 'Maria', dow: 2, time: '6:00 pm', duration: 60, frequency: 'weekly', pauseForHolidays: true, age: 'adult', instrument: 'Guitar', level: 'Beginner' },
  { name: 'Emma', dow: 2, time: '7:00 pm', duration: 60, frequency: 'weekly', pauseForHolidays: false, age: 'adult', instrument: 'Bass', level: 'Intermediate' },
  { name: 'Michael', dow: 3, time: '1:00 pm', duration: 60, frequency: 'weekly', pauseForHolidays: false, age: 'adult', instrument: 'Guitar', level: 'Beginner' },
  { name: 'Hugo', dow: 3, time: '3:45 pm', duration: 45, frequency: 'weekly', pauseForHolidays: true, age: 'child', instrument: 'Guitar', level: 'Beginner' },
  { name: 'Anya', dow: 3, time: '5:15 pm', duration: 30, frequency: 'weekly', pauseForHolidays: true, age: 'child', instrument: 'Piano', level: 'Complete Beginner' },
  { name: 'Alex', dow: 3, time: '6:00 pm', duration: 60, frequency: 'weekly', pauseForHolidays: false, age: 'adult', instrument: 'Guitar', level: 'Beginner' },
  { name: 'Shannon', dow: 3, time: '7:15 pm', duration: 60, frequency: 'weekly', pauseForHolidays: false, age: 'adult', instrument: 'Guitar', level: 'Intermediate' },
  { name: 'Meja', dow: 4, time: '4:30 pm', duration: 75, frequency: 'weekly', pauseForHolidays: true, age: 'child', instrument: 'Guitar', level: 'Intermediate' },
  { name: 'Odie', dow: 4, time: '5:45 pm', duration: 30, frequency: 'weekly', pauseForHolidays: true, age: 'teen', instrument: 'Guitar', level: 'Beginner' },
  { name: 'Will', dow: 4, time: '6:15 pm', duration: 30, frequency: 'weekly', pauseForHolidays: true, age: 'child', instrument: 'Piano', level: 'Beginner' },
  { name: 'Javin', dow: 4, time: '6:45 pm', duration: 60, frequency: 'weekly', pauseForHolidays: true, age: 'teen', instrument: 'Guitar', level: 'Beginner' }
];

module.exports = { ROSTER };
