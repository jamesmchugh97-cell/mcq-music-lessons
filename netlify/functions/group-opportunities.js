// group-opportunities.js
// Netlify serverless function: lists the regular lessons that are open to becoming a group
// class, for the booking page. Only a first name, instrument, level, music styles, goals and
// the day and time are ever returned. No emails or surnames.
const gh = require('./group-helpers');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  try {
    const all = await gh.getAllListings();
    const open = all.filter(l => l.status !== 'taken').map(gh.publicListing);
    open.sort((a, b) => (a.dayOfWeek - b.dayOfWeek) || String(a.time).localeCompare(String(b.time)));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, listings: open }) };
  } catch (e) {
    console.error('[group-opportunities] error:', e && e.message ? e.message : e);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Could not load group classes right now.' }) };
  }
};
