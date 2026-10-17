// voucher-helpers.js
// Shared pieces for gift vouchers (a prepaid 5 or 10 lesson package that can be
// bought as a gift and used later, whenever the person receiving it likes):
// code making and tidying, prices, storage, and what is safe to show publicly.
//
// How a voucher's life goes:
//   1. Someone buys it on gift.html (create-gift-checkout.js -> Stripe Checkout).
//   2. Stripe tells stripe-webhook.js the payment went through; that makes the
//      voucher, stores it here, and emails the buyer the code.
//   3. The person who receives it enters the code on the booking page and picks
//      their own dates (get-voucher.js to look it up, redeem-voucher.js to book).
//      They can book all the lessons at once or a few at a time.
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

// Same per-lesson prices as create-payment-intent.js (packages are "same prices as
// above, paid upfront", so 5 lessons = 5 x the single price). If those prices ever
// change, change them here too.
const LESSON_PRICES_CENTS = { 30: 5000, 45: 7000, 60: 8500, 75: 10000, 90: 12000 };
const VOUCHER_LESSON_COUNTS = [5, 10];
const VOUCHER_VALID_YEARS = 3; // Australian gift card rules expect a minimum of 3 years

// No 0/O or 1/I/L, so a code read out loud or copied from a printout can't be mistyped as another character.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function voucherPriceCents(lessonCount, durationMinutes) {
  const per = LESSON_PRICES_CENTS[parseInt(durationMinutes, 10)];
  if (!per || !VOUCHER_LESSON_COUNTS.includes(parseInt(lessonCount, 10))) return null;
  return per * parseInt(lessonCount, 10);
}

function generateCode() {
  let raw = '';
  for (let i = 0; i < 12; i++) raw += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return 'MCQ-' + raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
}

// Accepts the code however it was typed: lower case, spaces, missing dashes.
function normalizeCode(input) {
  const cleaned = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = cleaned.startsWith('MCQ') ? cleaned.slice(3) : cleaned;
  if (body.length !== 12) return null;
  for (const ch of body) if (!CODE_ALPHABET.includes(ch)) return null;
  return 'MCQ-' + body.slice(0, 4) + '-' + body.slice(4, 8) + '-' + body.slice(8, 12);
}

function vouchersStore() {
  return getStore({ name: 'gift-vouchers', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}
function sessionIndexStore() {
  return getStore({ name: 'gift-voucher-sessions', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}

async function getVoucher(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  return await vouchersStore().get(c, { type: 'json' });
}
async function saveVoucher(voucher) {
  await vouchersStore().set(voucher.code, JSON.stringify(voucher));
}
async function listVouchers() {
  const store = vouchersStore();
  const { blobs } = await store.list();
  const out = [];
  for (const b of blobs) {
    const v = await store.get(b.key, { type: 'json' });
    if (v) out.push(v);
  }
  return out;
}

function lessonsUsed(voucher) {
  return (voucher.redemptions || []).reduce((n, r) => n + (r.lessons || 0), 0);
}
function lessonsRemaining(voucher) {
  return Math.max(0, voucher.lessonsTotal - lessonsUsed(voucher));
}
function isExpired(voucher, nowMs) {
  return !!voucher.expiresAt && voucher.expiresAt < new Date(nowMs || Date.now()).toISOString().slice(0, 10);
}

// Only what the person holding the code needs to see: never the buyer's email or payment details.
function publicView(voucher) {
  return {
    code: voucher.code,
    lessonsTotal: voucher.lessonsTotal,
    lessonsRemaining: lessonsRemaining(voucher),
    durationMinutes: voucher.durationMinutes,
    recipientName: voucher.recipientName || '',
    fromName: voucher.buyerName || '',
    message: voucher.message || '',
    expiresAt: voucher.expiresAt,
    expired: isExpired(voucher),
    void: voucher.status === 'void'
  };
}

function expiryDateFrom(purchasedAtMs) {
  const d = new Date(purchasedAtMs || Date.now());
  d.setUTCFullYear(d.getUTCFullYear() + VOUCHER_VALID_YEARS);
  return d.toISOString().slice(0, 10);
}

// Wrong-code lockout, shared by looking a voucher up AND booking with one, so
// guessing can't just move to whichever of the two has no limit. After 10
// wrong codes in 15 minutes, that visitor is locked out for 30 minutes.
const MAX_MISSES = 10;
const MISS_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 30 * 60 * 1000;
function attemptsStore() {
  return getStore({ name: 'voucher-attempts', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}
function callerKey(event) {
  const h = (event && event.headers) || {};
  return 'ip_' + (h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown');
}
async function lockoutMinutesLeft(event) {
  try {
    const rec = await attemptsStore().get(callerKey(event), { type: 'json' });
    if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) return Math.ceil((rec.lockedUntil - Date.now()) / 60000);
  } catch (e) {}
  return 0;
}
async function recordMiss(event) {
  try {
    const store = attemptsStore();
    const key = callerKey(event);
    const now = Date.now();
    let rec = await store.get(key, { type: 'json' });
    if (!rec || !rec.windowStart || (now - rec.windowStart) > MISS_WINDOW_MS) rec = { windowStart: now, misses: 0 };
    rec.misses = (rec.misses || 0) + 1;
    if (rec.misses >= MAX_MISSES) rec.lockedUntil = now + LOCKOUT_MS;
    await store.set(key, JSON.stringify(rec));
  } catch (e) {}
}

module.exports = {
  lockoutMinutesLeft,
  recordMiss,
  LESSON_PRICES_CENTS,
  VOUCHER_LESSON_COUNTS,
  VOUCHER_VALID_YEARS,
  voucherPriceCents,
  generateCode,
  normalizeCode,
  vouchersStore,
  sessionIndexStore,
  getVoucher,
  saveVoucher,
  listVouchers,
  lessonsUsed,
  lessonsRemaining,
  isExpired,
  publicView,
  expiryDateFrom
};
