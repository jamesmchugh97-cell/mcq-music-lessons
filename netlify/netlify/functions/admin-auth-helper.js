// admin-auth-helper.js
// The admin password check with lockout (5 wrong tries in 15 minutes locks that
// visitor out for 30 minutes), shared by the admin tools written from now on.
// The password itself is the ADMIN_PASSWORD setting in Netlify. If that setting
// is missing, nobody can get in.
const { getStore } = require('@netlify/blobs');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;
const ATTEMPT_WINDOW_MINUTES = 15;

function attempts() {
  return getStore({ name: 'admin-auth-attempts', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
}
function callerKey(event) {
  const h = (event && event.headers) || {};
  return 'ip_' + (h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown');
}

// Returns { ok: true } or { ok: false, status, error }.
async function checkAdmin(event, password) {
  const key = callerKey(event);
  const store = attempts();
  const now = Date.now();
  let rec = null;
  try { rec = await store.get(key, { type: 'json' }); } catch (e) {}
  if (rec && rec.lockedUntil && rec.lockedUntil > now) {
    return { ok: false, status: 429, error: 'Too many incorrect attempts. Please try again in about ' + Math.ceil((rec.lockedUntil - now) / 60000) + ' minute(s).' };
  }
  if (!password || !process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    try {
      if (!rec || !rec.windowStart || (now - rec.windowStart) > ATTEMPT_WINDOW_MINUTES * 60 * 1000) rec = { windowStart: now, failedCount: 0 };
      rec.failedCount = (rec.failedCount || 0) + 1;
      if (rec.failedCount >= MAX_FAILED_ATTEMPTS) rec.lockedUntil = now + LOCKOUT_MINUTES * 60 * 1000;
      await store.set(key, JSON.stringify(rec));
    } catch (e) {}
    return { ok: false, status: 401, error: 'Incorrect password.' };
  }
  try { await store.delete(key); } catch (e) {}
  return { ok: true };
}

module.exports = { checkAdmin };
