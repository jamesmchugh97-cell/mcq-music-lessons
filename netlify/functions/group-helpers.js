// group-helpers.js
// Shared pieces for the "join a group class" feature.
//
// How it works:
//   1. A student who has a regular lesson can say they are open to sharing it as a group
//      class (ticked when enrolling, or added by James for his regular students). Their
//      lesson then appears as an "opportunity" on the booking page, showing only a first
//      name, the instrument, level, music styles, goals and the day and time. Never an
//      email address or surname.
//   2. A new student asks to join one. The student who owns that lesson gets an email with
//      a private link to say yes or no. James is told at every step.
//   3. Once the owner says yes, the lesson is marked as taken and everyone is emailed. James
//      then sets up the group price and calendar himself.
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';
const SITE = process.env.URL || 'https://mcqmusiclessons.com.au';
// A request nobody has answered stops blocking the lesson after this many days.
const PENDING_DAYS = 7;
// A group class can have up to this many students (the owner of the lesson plus others).
const MAX_GROUP = 3;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Regular students who are not enrolled through the website (their lessons are kept in the
// booking page's own list). They can be asked to share too, but they have no email on file, so
// James is the one asked, and he asks them in person. Keep in step with RECURRING_STUDENTS in
// booking.html.
const ROSTER = [
  { name: 'Meja', age: 'child', instrument: 'Guitar', level: 'Intermediate', dow: 1, time: '4:00 pm', duration: 75 },
  { name: 'Nick', age: 'adult', instrument: 'Guitar', level: 'Intermediate', dow: 1, time: '6:00 pm', duration: 90 },
  { name: 'Maria', age: 'adult', instrument: 'Guitar', level: 'Beginner', dow: 2, time: '6:00 pm', duration: 60 },
  { name: 'Emma', age: 'adult', instrument: 'Bass', level: 'Intermediate', dow: 2, time: '7:00 pm', duration: 60 },
  { name: 'Michael', age: 'adult', instrument: 'Guitar', level: 'Beginner', dow: 3, time: '1:00 pm', duration: 60 },
  { name: 'Hugo', age: 'child', instrument: 'Guitar', level: 'Beginner', dow: 3, time: '3:45 pm', duration: 45 },
  { name: 'Anya', age: 'child', instrument: 'Piano', level: 'Complete Beginner', dow: 3, time: '5:15 pm', duration: 30 },
  { name: 'Alex', age: 'adult', instrument: 'Guitar', level: 'Beginner', dow: 3, time: '6:00 pm', duration: 60 },
  { name: 'Shannon', age: 'adult', instrument: 'Guitar', level: 'Intermediate', dow: 3, time: '7:15 pm', duration: 60 },
  { name: 'Meja', age: 'child', instrument: 'Guitar', level: 'Intermediate', dow: 4, time: '4:30 pm', duration: 75 },
  { name: 'Odie', age: 'teen', instrument: 'Guitar', level: 'Beginner', dow: 4, time: '5:45 pm', duration: 30 },
  { name: 'Will', age: 'child', instrument: 'Piano', level: 'Beginner', dow: 4, time: '6:15 pm', duration: 30 },
  { name: 'Javin', age: 'teen', instrument: 'Guitar', level: 'Beginner', dow: 4, time: '6:45 pm', duration: 60 }
];

// Students are only ever matched within the same age group: child = young learner (under 13),
// teen = teenage learner (13 to 17), adult = adult learner (18 and over).
function cleanAge(v) { return v === 'adult' || v === 'teen' || v === 'child' ? v : ''; }
function ageWords(v) { return v === 'child' ? 'young learners (under 13)' : (v === 'teen' ? 'teenage learners (13 to 17)' : (v === 'adult' ? 'adult learners' : '')); }

// Age group and level for students who enrolled online, as James told us. These win over what is
// on their enrolment, so their lessons can be matched straight away. New enrolments set their own.
const ONLINE_OVERRIDES = {
  'nick rhoden': { age: 'adult', level: 'Beginner' },
  'niamh clarke': { age: 'adult', level: 'Complete Beginner' },
  'jacqueline mclaren': { age: 'adult', level: 'Intermediate' },
  'lisa koenig': { age: 'child', level: 'Beginner' },
  'calypso valambert': { age: 'adult', level: 'Complete Beginner' }
};

function opts(name) { return { name: name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN }; }
function listingsStore() { return getStore(opts('group-listings')); }
function requestsStore() { return getStore(opts('group-requests')); }
function attemptsStore() { return getStore(opts('group-attempts')); }

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function clean(v, max) { return String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function firstNameOf(full) { return clean(full, 80).split(/\s+/)[0] || ''; }
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }
function randomToken() { return crypto.randomBytes(24).toString('hex'); }
function randomId() { return crypto.randomBytes(6).toString('hex'); }
// A short public id for a subscription, so the real Stripe id is never shown on the website.
function publicIdForSubscription(subscriptionId) {
  return 's' + crypto.createHash('sha256').update(String(subscriptionId)).digest('hex').slice(0, 12);
}

// What a group class costs each person while TWO students share it, and what the same lesson
// costs as a private lesson (the prices on the pricing page). When only one student is left,
// that student pays the private price again. Everybody is told this before they agree.
const GROUP_PRICE_CENTS = { 30: 3500, 45: 4500, 60: 5500, 75: 6500, 90: 7500 };
const PRIVATE_PRICE_CENTS = { 30: 5000, 45: 7000, 60: 8500, 75: 10000, 90: 12000 };
function dollars(cents) { return '$' + (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)); }
function groupCents(durationMinutes) { return GROUP_PRICE_CENTS[parseInt(durationMinutes, 10)] || null; }
function privateCents(durationMinutes) { return PRIVATE_PRICE_CENTS[parseInt(durationMinutes, 10)] || null; }
function groupPriceFor(durationMinutes) {
  const c = groupCents(durationMinutes);
  return c ? dollars(c) + ' each' : null;
}
// The plain-English rule, shown wherever someone is asked to agree.
function groupRuleText(durationMinutes) {
  const g = groupCents(durationMinutes), p = privateCents(durationMinutes);
  if (!g || !p) return 'The group price applies only while at least two students share the lesson. If everyone else stops coming, it becomes a private lesson again at the normal private price.';
  return 'The group price is ' + dollars(g) + ' per lesson, and it only applies while at least two students share the lesson. If everyone else stops coming, it becomes a private lesson again and goes back to the normal private price of ' + dollars(p) + ' per lesson.';
}

// What anyone may see about a lesson that is open to a group. Nothing that identifies a
// person beyond a first name.
function publicListing(l) {
  return {
    id: l.id,
    firstName: l.firstName,
    instrument: l.instrument,
    level: l.level,
    genres: l.genres,
    goals: l.goals,
    ageGroup: l.ageGroup || '',
    dayOfWeek: l.dayOfWeek,
    dayName: DAY_NAMES[l.dayOfWeek] || '',
    time: l.time,
    durationMinutes: l.durationMinutes,
    frequency: l.frequency,
    groupPrice: groupPriceFor(l.durationMinutes),
    status: l.status || 'available'
  };
}

async function listAllRequests() {
  const store = requestsStore();
  const { blobs } = await store.list({ prefix: 'req_' });
  const out = [];
  for (const b of blobs) {
    const r = await store.get(b.key, { type: 'json' });
    if (r) out.push(r);
  }
  return out;
}

// Wrong-use limit: at most 6 requests an hour from one visitor.
function callerKey(event) {
  const h = (event && event.headers) || {};
  return 'ip_' + (h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown');
}
async function overRequestLimit(event) {
  try {
    const rec = await attemptsStore().get(callerKey(event), { type: 'json' });
    const now = Date.now();
    if (rec && rec.windowStart && now - rec.windowStart < 3600000 && rec.count >= 6) return true;
  } catch (e) {}
  return false;
}
async function recordRequestAttempt(event) {
  try {
    const store = attemptsStore();
    const key = callerKey(event);
    const now = Date.now();
    let rec = await store.get(key, { type: 'json' });
    if (!rec || !rec.windowStart || now - rec.windowStart >= 3600000) rec = { windowStart: now, count: 0 };
    rec.count += 1;
    await store.set(key, JSON.stringify(rec));
  } catch (e) {}
}

async function sendMail(to, subject, html) {
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>', reply_to: JAMES_EMAIL, to: [to], subject: subject, html: html })
    });
    return !resp || resp.ok !== false;
  } catch (e) {
    console.error('[group] email failed:', e && e.message ? e.message : e);
    return false;
  }
}

function wrapEmail(inner) {
  return '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1b2233;line-height:1.6;">' + inner +
    '<p style="color:#7b8496;font-size:13px;margin-top:28px;">MCQ Music Lessons, 84 Nelson Rd, South Melbourne</p></div>';
}
function detailRows(rows) {
  return '<table style="border-collapse:collapse;margin:12px 0;">' + rows.filter(r => r[1]).map(r =>
    '<tr><td style="padding:3px 14px 3px 0;color:#7b8496;vertical-align:top;">' + esc(r[0]) + '</td><td style="padding:3px 0;">' + esc(r[1]) + '</td></tr>').join('') + '</table>';
}
function emailButton(href, label, primary) {
  return '<a href="' + esc(href) + '" style="display:inline-block;padding:12px 26px;margin:6px 8px 6px 0;border-radius:4px;text-decoration:none;font-weight:600;' +
    (primary ? 'background:#c9942a;color:#1b1405;' : 'background:#eef0f4;color:#1b2233;') + '">' + esc(label) + '</a>';
}

// Every lesson currently open to a group: regular students who opted in (read live from the
// subscriptions, so a cancelled or paused one disappears by itself) plus any James added by
// hand for his other regular students. A lesson already promised to someone is marked taken,
// and one with a request waiting is marked pending.
async function getAllListings() {
  const { listAllSubscriptions } = require('./subscription-helpers');
  const out = [];
  try {
    const subs = await listAllSubscriptions();
    subs.forEach(r => {
      // groupOpen: true = opted in (first name and goals shown), false = opted out (not shown at all),
      // anything else = shown without a name, so a new student can still ask to join.
      if (!r || r.status !== 'active' || r.groupOpen === false) return;
      const named = r.groupOpen === true;
      if (r.dayOfWeek === undefined || !r.time) return;
      out.push({
        id: publicIdForSubscription(r.subscriptionId), source: 'subscription', subscriptionId: r.subscriptionId,
        ownerName: r.studentName, ownerEmail: r.studentEmail, ownerFirstName: firstNameOf(r.studentName), firstName: named ? firstNameOf(r.studentName) : '',
        ageGroup: cleanAge((ONLINE_OVERRIDES[String(r.studentName || '').trim().toLowerCase()] || {}).age || r.ageGroup), instrument: r.instrument, level: (ONLINE_OVERRIDES[String(r.studentName || '').trim().toLowerCase()] || {}).level || r.skillLevel || '', genres: r.genreFocus || '', goals: named ? (r.groupGoals || '') : '',
        dayOfWeek: parseInt(r.dayOfWeek, 10), time: r.time, durationMinutes: parseInt(r.durationMinutes, 10) || 45, frequency: r.frequency || 'weekly'
      });
    });
  } catch (e) { console.error('[group] could not read subscriptions:', e && e.message ? e.message : e); }
  try {
    const store = listingsStore();
    const { blobs } = await store.list({ prefix: 'lst_' });
    for (const b of blobs) {
      const l = await store.get(b.key, { type: 'json' });
      if (l && l.active !== false) out.push(Object.assign({ source: 'manual', ownerFirstName: l.firstName }, l));
    }
  } catch (e) { console.error('[group] could not read manual listings:', e && e.message ? e.message : e); }
  ROSTER.forEach((r, i) => {
    out.push({
      id: 'r' + i, source: 'roster', ageGroup: cleanAge(r.age), ownerName: r.name, ownerEmail: JAMES_EMAIL, ownerFirstName: r.name, firstName: '',
      instrument: r.instrument || '', level: r.level || '', genres: '', goals: '', dayOfWeek: r.dow, time: r.time, durationMinutes: r.duration, frequency: 'weekly'
    });
  });
  // Age groups James has set by hand win over anything else.
  try {
    const store = listingsStore();
    const { blobs } = await store.list({ prefix: 'age_' });
    const over = {};
    for (const b of blobs) { const a = await store.get(b.key, { type: 'json' }); if (a) over[b.key.slice(4)] = cleanAge(a.ageGroup); }
    out.forEach(l => { if (over[l.id] !== undefined) l.ageGroup = over[l.id]; else l.ageGroup = cleanAge(l.ageGroup); });
  } catch (e) { out.forEach(l => { l.ageGroup = cleanAge(l.ageGroup); }); }
  const reqs = await listAllRequests();
  out.forEach(l => {
    const mine = reqs.filter(r => r.listingId === l.id);
    // Students in the class so far: the owner (unless they have left) plus anyone paid up or
    // already promised a place.
    const joined = mine.filter(r => r.status === 'approved' || r.status === 'active');
    const ownerGone = mine.some(r => r.status === 'active' && r.ownerLeft);
    l.members = (ownerGone ? 0 : 1) + joined.length;
    if (l.members >= MAX_GROUP) l.status = 'taken';
    else if (mine.some(r => r.status === 'pending' && Date.now() - new Date(r.createdAt).getTime() < PENDING_DAYS * 86400000)) l.status = 'pending';
    else l.status = 'available';
  });
  return out;
}

module.exports = {
  getAllListings,
  JAMES_EMAIL, SITE, DAY_NAMES, MAX_GROUP,
  listingsStore, requestsStore,
  cleanAge, ageWords, esc, clean, firstNameOf, validEmail, randomToken, randomId, publicIdForSubscription,
  groupPriceFor, groupCents, privateCents, dollars, groupRuleText, GROUP_PRICE_CENTS, PRIVATE_PRICE_CENTS, publicListing, listAllRequests,
  overRequestLimit, recordRequestAttempt, sendMail, wrapEmail, detailRows, emailButton
};
