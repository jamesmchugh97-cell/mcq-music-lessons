// admin-voucher.js
// Netlify serverless function: lets James make, re-send or cancel a gift voucher by hand
// from the password-gated admin page. Three jobs:
//   - create: for a voucher sold some other way (cash, bank transfer, in person), AND as the
//     fallback if an online purchase ever fails to produce its voucher - the voucher is made
//     in seconds and emailed to the buyer exactly like an online one.
//   - resend: email a voucher to its buyer again (lost email, wrong address - pass toEmail).
//   - void: cancel a voucher (for example after a refund) so it can no longer be used.
// Creating is protected by the same ADMIN_PASSWORD and lockout as the other admin tools.
const { checkAdmin } = require('./admin-auth-helper');
const vh = require('./voucher-helpers');
const emailTemplate = require('./email-template');

const JAMES_EMAIL = 'jamesmcqmusic@gmail.com';

async function sendEmail(to, subject, html, text) {
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'MCQ Music Lessons <booking@mcqmusiclessons.com.au>', reply_to: JAMES_EMAIL, to: [to], subject: subject, html: html, ...(text ? { text: text } : {}) })
    });
    return !resp || resp.ok !== false;
  } catch (e) {
    console.error('[admin-voucher] email failed:', e && e.message ? e.message : e);
    return false;
  }
}

function clean(v, max) { return String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function fail(status, error) { return { statusCode: status, body: JSON.stringify({ success: false, error: error }) }; }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return fail(400, 'Invalid request body'); }

  const auth = await checkAdmin(event, body.password);
  if (!auth.ok) return fail(auth.status, auth.error);

  const site = process.env.URL || 'https://mcqmusiclessons.com.au';
  try {
    if (body.action === 'create') {
      const lessonCount = parseInt(body.lessonCount, 10);
      const durationMinutes = parseInt(body.durationMinutes, 10);
      const price = vh.voucherPriceCents(lessonCount, durationMinutes);
      const buyerName = clean(body.buyerName, 80);
      const buyerEmail = clean(body.buyerEmail, 200).toLowerCase();
      if (!price) return fail(400, 'Please choose 5 or 10 lessons and a lesson length.');
      if (!buyerName) return fail(400, 'Please enter the buyer\'s name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) return fail(400, 'Please enter a valid buyer email address.');

      let code = null;
      for (let i = 0; i < 6; i++) {
        const candidate = vh.generateCode();
        if (!(await vh.getVoucher(candidate))) { code = candidate; break; }
      }
      if (!code) return fail(500, 'Could not make a unique code. Please try again.');
      const nowMs = Date.now();
      const voucher = {
        code: code, status: 'active', lessonsTotal: lessonCount, durationMinutes: durationMinutes, pricePaidCents: price,
        buyerName: buyerName, buyerEmail: buyerEmail, recipientName: clean(body.recipientName, 80), message: clean(body.message, 300),
        purchasedAt: new Date(nowMs).toISOString(), expiresAt: vh.expiryDateFrom(nowMs), paymentIntentId: null,
        sessionId: 'manual-' + code, createdBy: 'admin', redemptions: []
      };
      await vh.saveVoucher(voucher);
      let emailed = false;
      if (body.sendEmail !== false) {
        const mail = emailTemplate.giftVoucherEmail(voucher);
        emailed = await sendEmail(buyerEmail, mail.subject, mail.html, mail.text);
      }
      return { statusCode: 200, body: JSON.stringify({ success: true, code: code, emailed: emailed, printUrl: site + '/voucher.html?code=' + encodeURIComponent(code), redeemUrl: site + '/booking.html?voucher=' + encodeURIComponent(code) + '#package', voucher: vh.publicView(voucher) }) };
    }

    if (body.action === 'edit') {
      const voucher = await vh.getVoucher(body.code);
      if (!voucher) return fail(404, 'No voucher found with that code.');
      // Only the personal touches can change. Lessons, price, expiry and
      // redemptions are never touched here. A blank box keeps what is already there.
      const newRecipient = clean(body.recipientName, 80);
      const newMessage = clean(body.message, 300);
      const removeMessage = body.removeMessage === true;
      if (!newRecipient && !newMessage && !removeMessage) return fail(400, 'Please enter a new name or a new message, or choose to remove the message.');
      if (newRecipient) voucher.recipientName = newRecipient;
      if (newMessage) voucher.message = newMessage;
      else if (removeMessage) voucher.message = '';
      voucher.editedAt = new Date().toISOString();
      await vh.saveVoucher(voucher);
      return { statusCode: 200, body: JSON.stringify({ success: true, code: voucher.code, recipientName: voucher.recipientName || '', message: voucher.message || '' }) };
    }

    if (body.action === 'resend' || body.action === 'void') {
      const voucher = await vh.getVoucher(body.code);
      if (!voucher) return fail(404, 'No voucher found with that code.');
      if (body.action === 'void') {
        voucher.status = 'void';
        voucher.voidedAt = new Date().toISOString();
        voucher.voidReason = clean(body.reason, 200);
        await vh.saveVoucher(voucher);
        return { statusCode: 200, body: JSON.stringify({ success: true, code: voucher.code, status: 'void' }) };
      }
      const to = clean(body.toEmail, 200).toLowerCase() || voucher.buyerEmail;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail(400, 'Please enter a valid email address to send it to.');
      const mail = emailTemplate.giftVoucherEmail(voucher);
      const emailed = await sendEmail(to, mail.subject, mail.html, mail.text);
      return { statusCode: 200, body: JSON.stringify({ success: true, code: voucher.code, emailed: emailed, sentTo: to, lessonsRemaining: vh.lessonsRemaining(voucher) }) };
    }

    return fail(400, 'Unknown action.');
  } catch (err) {
    console.error('[admin-voucher] error:', err && err.message ? err.message : err);
    return fail(500, 'Something went wrong. Nothing further was changed.');
  }
};
