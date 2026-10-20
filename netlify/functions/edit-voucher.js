// edit-voucher.js
// Netlify serverless function: lets the person who BOUGHT a gift voucher change the
// name and message printed on it, for example when the gift is going to be given on a
// different day or to a different person. Nothing else can be changed here: lessons,
// price and expiry are never touched.
//
// To stop anyone else changing a voucher, the caller must give both the voucher code
// AND the email address the buyer used when paying. Wrong attempts count towards the
// same lockout as wrong codes elsewhere (see voucher-helpers.js).
const vh = require('./voucher-helpers');

function clean(v, max) { return String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function reply(status, obj) { return { statusCode: status, body: JSON.stringify(obj) }; }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { success: false, error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return reply(400, { success: false, error: 'Invalid request body' }); }

  const locked = await vh.lockoutMinutesLeft(event);
  if (locked > 0) {
    return reply(429, { success: false, error: 'Too many wrong attempts. Please try again in about ' + locked + ' minute(s), or contact James.' });
  }

  const email = clean(body.buyerEmail, 200).toLowerCase();
  const newRecipient = clean(body.recipientName, 80);
  const newMessage = clean(body.message, 300);

  try {
    const voucher = await vh.getVoucher(body.code);
    // The same wording for a wrong code and a wrong email, so this can't be used
    // to find out whether a particular code exists.
    if (!voucher || !email || String(voucher.buyerEmail || '').toLowerCase() !== email) {
      await vh.recordMiss(event);
      return reply(200, { success: false, error: 'We couldn\'t match that code and email. Please use the email address you paid with, or contact James.' });
    }
    if (voucher.status === 'void') return reply(200, { success: false, error: 'That voucher has been cancelled. Please contact James.' });
    const removeMessage = body.removeMessage === true;
    if (!newRecipient && !newMessage && !removeMessage) return reply(200, { success: false, error: 'Please enter a new name or a new message, or choose to remove the message.' });

    if (newRecipient) voucher.recipientName = newRecipient;
    // A new message replaces the old one completely. Ticking "remove" with nothing typed clears it.
    if (newMessage) voucher.message = newMessage;
    else if (removeMessage) voucher.message = '';
    voucher.editedAt = new Date().toISOString();
    await vh.saveVoucher(voucher);
    return reply(200, { success: true, code: voucher.code, recipientName: voucher.recipientName || '', message: voucher.message || '' });
  } catch (err) {
    console.error('[edit-voucher] error:', err && err.message ? err.message : err);
    return reply(500, { success: false, error: 'Something went wrong. Nothing was changed. Please try again or contact James.' });
  }
};
