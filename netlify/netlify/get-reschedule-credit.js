// Netlify serverless function: looks up a reschedule credit by its token,
// used to verify a "rebook this week" link from a cancellation email is
// still valid (not already used, not past its week window) before the
// reschedule panel shows itself. Read-only: this never books anything or
// touches payment, it just answers "is this link still good?".
const { getStore } = require('@netlify/blobs');
exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ valid: false, error: 'Method not allowed' }) };
  }
  const token = event.queryStringParameters && event.queryStringParameters.token;
  if (!token) {
    return { statusCode: 200, body: JSON.stringify({ valid: false, error: 'Missing reschedule link.' }) };
  }
  try {
    const store = getStore({ name: 'reschedule-credits', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN });
    const credit = await store.get(token, { type: 'json' });
    if (!credit) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, error: 'This reschedule link is invalid. Please contact James directly.' }) };
    }
    if (credit.used) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, error: 'This reschedule link has already been used.' }) };
    }
    const todayStr = new Date().toISOString().split('T')[0];
    if (todayStr > credit.weekEnd) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, error: 'This reschedule link has expired. It was only valid for the two weeks following your cancelled lesson. Please contact James directly.' }) };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        valid: true,
        name: credit.name,
        duration: credit.duration,
        weekStart: credit.weekStart,
        weekEnd: credit.weekEnd,
        originalDate: credit.originalDate,
        originalTime: credit.originalTime
      })
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ valid: false, error: err.message }) };
  }
};
