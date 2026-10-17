// get-voucher.js
// Netlify serverless function: looks up a gift voucher by its code, for the
// booking page (before redeeming) and the printable voucher page. It returns
// only what the person holding the code needs - never the buyer's email or
// payment details.
//
// Codes are long and random, so guessing one isn't realistic, but wrong
// guesses are still limited (see voucher-helpers.js).
const { getVoucher, publicView, lockoutMinutesLeft, recordMiss } = require('./voucher-helpers');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body' }) };
  }

  const locked = await lockoutMinutesLeft(event);
  if (locked > 0) {
    return { statusCode: 429, body: JSON.stringify({ success: false, error: 'Too many wrong codes. Please try again in about ' + locked + ' minute(s), or contact James.' }) };
  }

  let voucher = null;
  try { voucher = await getVoucher(body.code); } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Something went wrong looking that up. Please try again.' }) };
  }

  if (!voucher) {
    await recordMiss(event);
    return { statusCode: 200, body: JSON.stringify({ success: false, error: 'We couldn\'t find a voucher with that code. Please check it and try again.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ success: true, voucher: publicView(voucher) }) };
};
