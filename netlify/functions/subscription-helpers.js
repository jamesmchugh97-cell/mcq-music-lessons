// subscription-helpers.js
// Shared logic for the live "subscriptions" Blobs store, used by
// create-subscription.js, stripe-webhook.js, manage-subscription.js,
// pause-expiry-check.js, reserve-multi-slots.js, and
// redeem-reschedule-credit.js. This store is what actually blocks and
// frees a subscriber's weekly/fortnightly slot in real time (active =
// blocked, paused = freed), it works alongside, not instead of, the
// old hardcoded RECURRING_STUDENTS roster used for James's existing
// manually-managed students.
const { getStore } = require('@netlify/blobs');
const { deleteCalendarEvent } = require('./google-calendar-helper');

const MAX_PAUSE_WEEKS_PER_YEAR = 4;
const PAYMENT_GRACE_PERIOD_DAYS = 5; // days after a payment first fails before the slot is automatically released
const PAYMENT_REMINDER_AFTER_DAYS = 3; // days after a payment first fails before sending a warning email (2-day heads up before release)

// A slot is locked in via reserve-multi-slots.js BEFORE the card is
// actually charged (so two people can never both pay for the same
// time), marked pendingPayment: true with a reservedAt timestamp until
// confirm-reservation.js clears it on a successful payment. Any code
// that treats an existing booking record as a real, blocking conflict
// needs to know about this - otherwise an abandoned or failed checkout
// would wrongly keep blocking that slot from everyone else (a new
// one-off booking, a new subscriber, a reschedule target, or even just
// what the calendar displays) long after the person who reserved it
// ever came back. Shared here since this same check is genuinely
// needed in reserve-multi-slots.js, get-bookings.js,
// create-subscription.js, stripe-webhook.js, and
// redeem-reschedule-credit.js - five places is exactly the point where
// one copy stops being convenient duplication and starts being a real
// risk of drifting out of sync with each other.
const RESERVATION_HOLD_MINUTES = 20;
function isStalePendingHold(record) {
  if (!record || record.pendingPayment !== true || !record.reservedAt) return false;
  const ageMs = Date.now() - new Date(record.reservedAt).getTime();
  return ageMs > RESERVATION_HOLD_MINUTES * 60 * 1000;
}

// Victorian government school summer holidays, 2026-2027. A separate
// allowance from the normal 4-week pause budget, specifically for this
// window, so families whose kids are off school for a genuinely long
// stretch aren't forced to either burn their whole yearly allowance on
// one break or cancel outright and risk losing their slot. These dates
// need updating by hand each year - school holiday dates aren't on a
// fixed formula, so there's no safe way to calculate them automatically.
const SUMMER_PAUSE_START = '2026-12-19';
const SUMMER_PAUSE_END = '2027-01-26';
const MAX_SUMMER_PAUSE_WEEKS = 6;

// Shared with create-subscription.js and manage-subscription.js (for
// the changeFrequency action), so there's exactly one source of truth
// for these instead of two copies that could drift out of sync.
const PRICE_IDS = {
  '30_weekly': 'price_1U2PyCAOM8tPKKgkdcq71eaP',
  '30_fortnightly': 'price_1U2Q23AOM8tPKKgkzEozmG31',
  '45_weekly': 'price_1U2Q64AOM8tPKKgkxAsei52J',
  '45_fortnightly': 'price_1U2Q7LAOM8tPKKgkQovjrxBD',
  '60_weekly': 'price_1U2Q8jAOM8tPKKgkd1rMpX1A',
  '60_fortnightly': 'price_1U2Q9AAOM8tPKKgk3VG8itQN',
  '75_weekly': 'price_1U2QBIAOM8tPKKgkrNFPjDhZ',
  '75_fortnightly': 'price_1U2QBkAOM8tPKKgkMnVMuT2O',
  '90_weekly': 'price_1U2QCNAOM8tPKKgkJUtWzyEL',
  '90_fortnightly': 'price_1U2QCqAOM8tPKKgknCBOj1VG'
};

function subsStore() {
  return getStore({ name: 'subscriptions', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

function bookingsStore() {
  return getStore({ name: 'bookings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

// Shared by every path that can pause a subscription (a student's own
// last-minute pause, a scheduled summer break starting, or an admin
// closure starting). If an already-booked, already-paid-for upcoming
// lesson now falls inside the pause window, it's cleared off the
// calendar and booking system as part of processing the pause, rather
// than left dangling (which would mean James still expects them, with
// zero warning, for a lesson they're not coming to). No reschedule
// credit is issued for it, since the student is taking a broader break,
// not asking to move one specific lesson - their normal schedule simply
// resumes after the pause ends. This costs James nothing: that lesson
// was already invoiced and paid for before the pause was requested,
// pausing only ever affects FUTURE billing, never refunds something
// already collected.
async function clearImminentLessonIfWithinPause(record, pausedUntilStr) {
  if (!record.nextLessonDate) return null;
  const todayStr = new Date().toISOString().slice(0, 10);
  if (record.nextLessonDate < todayStr || record.nextLessonDate >= pausedUntilStr) return null;
  const store = bookingsStore();
  const key = record.nextLessonDate + '_' + record.time;
  const booking = await store.get(key, { type: 'json' });
  if (!booking) return null;
  // Ownership check: the record at this key must actually belong to the
  // pausing subscriber. record.nextLessonDate can go stale - if the
  // subscriber cancelled that specific lesson via Manage Booking and a
  // DIFFERENT student then booked a one-off in the freed slot, the key
  // now holds that other student's paid booking, which must never be
  // deleted as a side effect of this subscriber pausing.
  const bookingEmail = (booking.email || '').trim().toLowerCase();
  const subscriberEmail = (record.studentEmail || '').trim().toLowerCase();
  if (!bookingEmail || !subscriberEmail || bookingEmail !== subscriberEmail) return null;
  await store.delete(key);
  if (booking.eventId) {
    try {
      await deleteCalendarEvent(booking.eventId);
    } catch (e) {
      console.error('[subscription-helpers] calendar delete failed for', key, ':', e && e.message ? e.message : e);
    }
  }
  return record.nextLessonDate;
}

// A single small store for site-wide settings, currently just the
// admin-set studio closure window (see admin-closure.js). Deliberately
// separate from the per-subscription "subscriptions" store since this
// is one shared setting, not per-student data.
function settingsStore() {
  return getStore({ name: 'studio-settings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

async function getClosureSettings() {
  const store = settingsStore();
  return await store.get('closure', { type: 'json' });
}

async function saveClosureSettings(record) {
  const store = settingsStore();
  await store.set('closure', JSON.stringify(record));
}

async function deleteClosureSettings() {
  const store = settingsStore();
  await store.delete('closure');
}

// Every email built anywhere in this codebase interpolates user-
// supplied text (name, instrument, notes, etc.) directly into HTML,
// with nothing escaping it anywhere. That means a name field crafted
// with real HTML - a fake link, a misleading "click here", hidden
// text - would render as actual formatted content in an email sent
// from this site's own trusted domain, to either a student or James
// himself. Most email clients block real script execution, but HTML
// structure injection for phishing or social engineering doesn't need
// script to work. Shared here so every file that builds an email can
// wrap user-supplied fields with it consistently.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
// includeStatuses defaults to active-only, matching the original
// behavior every existing caller relies on (a paused slot is free for
// one-off bookings and reschedules - that's the whole point of
// pausing). Callers deciding whether a NEW SUBSCRIPTION can start here
// pass ['active', 'paused'] instead, since letting a new subscriber
// claim a slot that's only temporarily free would collide with the
// paused student's own return - see create-subscription.js and
// stripe-webhook.js's slotStillFree.
async function listBlockingSubscriptionsForDay(dow, excludeSubscriptionId, includeStatuses) {
  const statuses = includeStatuses || ['active'];
  const store = subsStore();
  const { blobs } = await store.list({ prefix: 'sub_' });
  const results = [];
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' });
    if (!record) continue;
    if (record.subscriptionId === excludeSubscriptionId) continue;
    if (!statuses.includes(record.status)) continue;
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

// Separate from pausedWeeksThisYear on purpose - the summer allowance is
// its own budget, tied to SUMMER_PAUSE_START/END above, not the rolling
// calendar year, and never touches or is touched by the regular 4-week
// pause tracking.
function summerWeeksUsed(record) {
  return record.summerWeeksUsed || 0;
}
function canUseSummerWeeks(record, requestedWeeks) {
  return (summerWeeksUsed(record) + requestedWeeks) <= MAX_SUMMER_PAUSE_WEEKS;
}

function canPauseWeeks(record, requestedWeeks) {
  const used = pausedWeeksThisYear(record);
  return (used + requestedWeeks) <= MAX_PAUSE_WEEKS_PER_YEAR;
}

// If someone cancels a subscription and starts a new one again within
// this many days, the gap counts against the same annual pause-week
// allowance pausing already uses, instead of resetting to a clean
// slate. Pausing itself maxes out at 4 weeks in a single go, so a
// threshold a little past that catches "skip a few weeks by cancelling
// and resubscribing" without penalizing someone who's genuinely been
// away much longer and is legitimately starting fresh.
const RESUBSCRIBE_GAP_DAYS = 35;

function historyStore() {
  return getStore({ name: 'subscriber-history', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

async function getEmailHistory(email) {
  if (!email) return null;
  const store = historyStore();
  return await store.get('email_' + email.trim().toLowerCase(), { type: 'json' });
}

async function saveEmailHistory(email, record) {
  if (!email) return;
  const store = historyStore();
  await store.set('email_' + email.trim().toLowerCase(), JSON.stringify(record));
}

// Same year-rollover reset logic as pausedWeeksThisYear above, just
// scoped to the student (persists across subscription IDs) rather than
// one specific subscription record.
function emailPausedWeeksThisYear(historyRecord) {
  if (!historyRecord || !historyRecord.pauseYear || historyRecord.pauseYear !== currentYear()) return 0;
  return historyRecord.pausedWeeksThisYear || 0;
}

// Called when a brand new subscription's first payment succeeds, before
// its own pausedWeeksThisYear is set. Returns how many weeks should be
// inherited as already "used" this year: whatever pause weeks this
// email has already used (on any earlier subscription), plus - if their
// last subscription ended within RESUBSCRIBE_GAP_DAYS - the gap itself,
// treated as an unlogged pause. Not capped at MAX_PAUSE_WEEKS_PER_YEAR
// here; canPauseWeeks() already blocks further pausing correctly once
// the inherited total meets or exceeds the cap on its own.
function inheritedPauseWeeksForNewSubscription(historyRecord) {
  let weeks = emailPausedWeeksThisYear(historyRecord);
  if (historyRecord && historyRecord.lastEndedAt) {
    const daysSinceEnded = Math.floor((Date.now() - new Date(historyRecord.lastEndedAt + 'T00:00:00').getTime()) / 86400000);
    if (daysSinceEnded >= 0 && daysSinceEnded <= RESUBSCRIBE_GAP_DAYS) {
      weeks += Math.max(1, Math.round(daysSinceEnded / 7));
    }
  }
  return weeks;
}

module.exports = {
  MAX_PAUSE_WEEKS_PER_YEAR,
  PAYMENT_GRACE_PERIOD_DAYS,
  PAYMENT_REMINDER_AFTER_DAYS,
  RESUBSCRIBE_GAP_DAYS,
  SUMMER_PAUSE_START,
  SUMMER_PAUSE_END,
  MAX_SUMMER_PAUSE_WEEKS,
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
  canPauseWeeks,
  summerWeeksUsed,
  canUseSummerWeeks,
  getEmailHistory,
  saveEmailHistory,
  emailPausedWeeksThisYear,
  inheritedPauseWeeksForNewSubscription,
  getClosureSettings,
  saveClosureSettings,
  deleteClosureSettings,
  clearImminentLessonIfWithinPause,
  PRICE_IDS,
  RESERVATION_HOLD_MINUTES,
  isStalePendingHold,
  escapeHtml
};
