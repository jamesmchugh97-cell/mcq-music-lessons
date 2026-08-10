// subscription-helpers.js
// Shared logic for the live "subscriptions" Blobs store, used by
// create-subscription.js, stripe-webhook.js, manage-subscription.js,
// pause-expiry-check.js, reserve-multi-slots.js, and
// redeem-reschedule-credit.js. This store is what actually blocks and
// frees a subscriber's weekly/fortnightly slot in real time (active =
// blocked, paused = freed) — it works alongside, not instead of, the
// old hardcoded RECURRING_STUDENTS roster used for James's existing
// manually-managed students.
const { getStore } = require('@netlify/blobs');

const MAX_PAUSE_WEEKS_PER_YEAR = 4;
const PAYMENT_GRACE_PERIOD_DAYS = 5; // days after a payment first fails before the slot is automatically released
const PAYMENT_REMINDER_AFTER_DAYS = 3; // days after a payment first fails before sending a warning email (2-day heads up before release)

function subsStore() {
  return getStore({ name: 'subscriptions', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

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

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay();
}

function currentYear() {
  return new Date().getFullYear();
}

async function getSubscriptionRecord(subscriptionId) {
  const store = subsStore();
  return await store.get('sub_' + subscriptionId, { type: 'json' });
}

async function saveSubscriptionRecord(subscriptionId, record) {
  const store = subsStore();
  await store.set('sub_' + subscriptionId, JSON.stringify(record));
}

async function deleteSubscriptionRecord(subscriptionId) {
  const store = subsStore();
  try { await store.delete('sub_' + subscriptionId); } catch (e) {}
}

// Returns every subscription record whose weekly slot falls on the given
// day of week and is currently blocking that slot (status 'active'; a
// 'paused' subscription does NOT block, since the whole point of pausing
// is to free the slot up for that window).
async function listBlockingSubscriptionsForDay(dow, excludeSubscriptionId) {
  const store = subsStore();
  const { blobs } = await store.list({ prefix: 'sub_' });
  const results = [];
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' });
    if (!record) continue;
    if (record.subscriptionId === excludeSubscriptionId) continue;
    if (record.status !== 'active') continue;
    if (parseInt(record.dayOfWeek, 10) !== dow) continue;
    results.push(record);
  }
  return results;
}

function conflictsWithSubscriptions(subs, startMinutes, endMinutes) {
  return subs.some(s => {
    const sStart = timeToMinutes(s.time);
    const sEnd = sStart + parseInt(s.durationMinutes, 10);
    return startMinutes < sEnd && sStart < endMinutes;
  });
}

// Returns every subscription record regardless of status or day - used
// by subscription-payment-grace-check.js to scan every active
// subscription for an unresolved payment failure, not just those
// blocking one particular day (which is what
// listBlockingSubscriptionsForDay is for).
async function listAllSubscriptions() {
  const store = subsStore();
  const { blobs } = await store.list({ prefix: 'sub_' });
  const results = [];
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' });
    if (record) results.push(record);
  }
  return results;
}

// Finds the next date matching the given day-of-week/time that is at
// least minNoticeHours away, using Melbourne local time so DST doesn't
// throw off the 24-hour check. Optionally requires the date to be
// strictly after afterDateStr (used to advance to the NEXT lesson on
// each billing renewal rather than recomputing "now").
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

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function nextOccurrenceDate(dow, time, minNoticeHours, afterDateStr) {
  let cursor = new Date();
  if (afterDateStr) {
    cursor = new Date(afterDateStr + 'T00:00:00');
    cursor.setDate(cursor.getDate() + 1);
  }
  for (let i = 0; i < 21; i++) {
    if (cursor.getDay() === dow) {
      const dateStr = toDateStr(cursor);
      const hoursAway = (melbourneEpochMs(dateStr, time) - Date.now()) / (1000 * 60 * 60);
      if (!afterDateStr && hoursAway < minNoticeHours) {
        cursor.setDate(cursor.getDate() + 1);
        continue;
      }
      return dateStr;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return null; // should never happen
}

// Used only for RENEWAL invoices, not the first lesson. The next lesson
// is always exactly one billing interval (7 days for weekly, 14 for
// fortnightly) after the previous one - not just "the next matching
// weekday", which is always 7 days out regardless of frequency and
// would silently turn every fortnightly subscription into a weekly
// one. nextOccurrenceDate() above is still correct and still used for
// finding the FIRST lesson date, where "next matching weekday that's
// >=24 hours away" is exactly what's needed.
function nextRenewalDate(afterDateStr, frequency) {
  const stepDays = frequency === 'fortnightly' ? 14 : 7;
  const d = new Date(afterDateStr + 'T00:00:00');
  d.setDate(d.getDate() + stepDays);
  return toDateStr(d);
}

// Pause-cap check: resets the counter automatically when the calendar
// year has rolled over since the record was last touched.
function pausedWeeksThisYear(record) {
  if (!record.pauseYear || record.pauseYear !== currentYear()) return 0;
  return record.pausedWeeksThisYear || 0;
}

function canPauseWeeks(record, requestedWeeks) {
  const used = pausedWeeksThisYear(record);
  return (used + requestedWeeks) <= MAX_PAUSE_WEEKS_PER_YEAR;
}

module.exports = {
  MAX_PAUSE_WEEKS_PER_YEAR,
  PAYMENT_GRACE_PERIOD_DAYS,
  PAYMENT_REMINDER_AFTER_DAYS,
  timeToMinutes,
  dayOfWeek,
  currentYear,
  getSubscriptionRecord,
  saveSubscriptionRecord,
  deleteSubscriptionRecord,
  listBlockingSubscriptionsForDay,
  listAllSubscriptions,
  conflictsWithSubscriptions,
  nextOccurrenceDate,
  nextRenewalDate,
  pausedWeeksThisYear,
  canPauseWeeks
};
