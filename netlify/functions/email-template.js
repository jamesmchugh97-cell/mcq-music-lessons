// email-template.js
// The look of the gift voucher emails: a clean branded layout built the way
// email programs need (tables and inline styles, no scripts), a gift voucher
// "certificate" that prints well straight from the email (light background,
// dark text, thin gold border), and a plain-text version of each email for
// programs and people that prefer it.
//
// Every piece of text that came from a person (names, messages) goes through
// esc() so it can never be treated as HTML.
const SITE = 'https://mcqmusiclessons.com.au';
const ADDRESS = '84 Nelson Rd, South Melbourne VIC 3205';
const MAPS = 'https://maps.google.com/?q=' + encodeURIComponent('84 Nelson Rd, South Melbourne VIC 3205');

const C = { gold: '#c9942a', goldDark: '#8a6414', goldLine: '#e3c987', navy: '#0d1321', ink: '#1b2233', text: '#3a4152', muted: '#7b8496', page: '#f3efe7', cream: '#fffdf7', line: '#e8e1d2' };
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function niceDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function niceDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function button(href, label, primary) {
  const bg = primary ? C.gold : '#ffffff';
  const fg = primary ? '#1b1405' : C.goldDark;
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 20px;"><tr><td align="center" style="border-radius:4px;background:' + bg + ';border:1px solid ' + C.gold + ';">' +
    '<a href="' + esc(href) + '" style="display:inline-block;padding:13px 28px;font-family:' + SANS + ';font-size:15px;font-weight:600;color:' + fg + ';text-decoration:none;">' + esc(label) + '</a></td></tr></table>';
}

// The whole email: header band, body, footer. preheader = the short line shown next to the subject in the inbox.
function wrap(opts) {
  const pre = opts.preheader ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#ffffff;font-size:1px;line-height:1px;">' + esc(opts.preheader) + '</div>' : '';
  return '<!DOCTYPE html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(opts.title || 'MCQ Music Lessons') + '</title></head>' +
    '<body style="margin:0;padding:0;background:' + C.page + ';">' + pre +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.page + ';"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:6px;overflow:hidden;border:1px solid ' + C.line + ';">' +
      '<tr><td style="background:' + C.navy + ';padding:22px 28px;"><span style="font-family:' + SERIF + ';font-size:22px;color:' + C.gold + ';letter-spacing:1px;">&#9833;&nbsp; MCQ <span style="color:#ffffff;">Music Lessons</span></span></td></tr>' +
      '<tr><td style="padding:30px 28px 24px;font-family:' + SANS + ';font-size:15px;line-height:1.65;color:' + C.text + ';">' + opts.bodyHtml + '</td></tr>' +
      '<tr><td style="background:' + C.cream + ';border-top:1px solid ' + C.line + ';padding:18px 28px;font-family:' + SANS + ';font-size:12px;line-height:1.6;color:' + C.muted + ';text-align:center;">' +
        'MCQ Music Lessons &middot; <a href="' + MAPS + '" style="color:' + C.muted + ';">' + esc(ADDRESS) + '</a><br>' +
        '<a href="mailto:jamesmcqmusic@gmail.com" style="color:' + C.muted + ';">jamesmcqmusic@gmail.com</a> &middot; <a href="tel:0499232898" style="color:' + C.muted + ';">0499 232 898</a> &middot; ABN 62 103 386 186' +
      '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function h1(text) { return '<h1 style="margin:0 0 14px;font-family:' + SERIF + ';font-size:26px;line-height:1.25;font-weight:normal;color:' + C.ink + ';">' + esc(text) + '</h1>'; }
function p(html) { return '<p style="margin:0 0 14px;">' + html + '</p>'; }
function h3(text) { return '<p style="margin:22px 0 8px;font-family:' + SERIF + ';font-size:18px;color:' + C.ink + ';">' + esc(text) + '</p>'; }

// The gift voucher itself. Light background and dark text on purpose, so it prints
// cleanly on plain paper (and looks the same on screen).
function voucherCertificate(v) {
  const lessonsWord = v.lessonsTotal + ' music lesson' + (v.lessonsTotal === 1 ? '' : 's');
  const rows = [];
  if (v.recipientName) rows.push('<div style="font-family:' + SERIF + ';font-size:22px;color:' + C.goldDark + ';margin-top:14px;">For ' + esc(v.recipientName) + '</div>');
  const from = v.fromName || v.buyerName; // the stored voucher calls it buyerName, the public view calls it fromName
  if (from) rows.push('<div style="font-size:14px;color:' + C.text + ';margin-top:' + (v.recipientName ? '2' : '14') + 'px;">From ' + esc(from) + '</div>');
  if (v.message) rows.push('<div style="font-size:14px;line-height:1.6;color:' + C.text + ';font-style:italic;margin:12px auto 0;max-width:400px;">&ldquo;' + esc(v.message) + '&rdquo;</div>');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid ' + C.gold + ';border-radius:6px;background:' + C.cream + ';margin:6px 0 4px;"><tr><td style="padding:6px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + C.goldLine + ';border-radius:4px;"><tr><td align="center" style="padding:30px 22px 26px;">' +
      '<div style="font-family:' + SANS + ';font-size:11px;letter-spacing:3px;text-transform:uppercase;color:' + C.goldDark + ';">MCQ Music Lessons &middot; South Melbourne</div>' +
      '<div style="font-family:' + SERIF + ';font-size:38px;line-height:1.15;color:' + C.ink + ';margin:8px 0 10px;">Gift Voucher</div>' +
      '<div style="width:60px;height:2px;background:' + C.gold + ';margin:0 auto 16px;font-size:0;line-height:0;">&nbsp;</div>' +
      '<div style="font-family:' + SERIF + ';font-size:24px;color:' + C.ink + ';">' + esc(lessonsWord) + '</div>' +
      '<div style="font-family:' + SANS + ';font-size:14px;color:' + C.text + ';margin-top:2px;">' + esc(v.durationMinutes) + ' minutes each &middot; guitar or piano</div>' +
      rows.join('') +
      '<div style="margin:22px auto 6px;display:inline-block;border:1px dashed ' + C.gold + ';border-radius:4px;padding:11px 18px;font-family:\'Courier New\',Courier,monospace;font-size:22px;letter-spacing:3px;color:' + C.ink + ';background:#ffffff;white-space:nowrap;">' + esc(v.code) + '</div>' +
      '<div style="font-family:' + SANS + ';font-size:12px;color:' + C.muted + ';">Valid until ' + esc(niceDay(v.expiresAt)) + '</div>' +
      '<div style="font-family:' + SANS + ';font-size:13px;line-height:1.7;color:' + C.text + ';text-align:left;margin-top:22px;padding-top:16px;border-top:1px solid ' + C.line + ';">' +
        '<strong style="color:' + C.ink + ';">How to use this voucher</strong><br>' +
        '1. Go to <a href="' + esc(v.redeemUrl || (SITE + '/booking.html#package')) + '" style="color:' + C.goldDark + ';font-weight:bold;">mcqmusiclessons.com.au/booking.html#package</a> and enter the code above.<br>' +
        '2. Choose a date and time for each lesson. Book them all at once, or a few at a time, whenever suits (up to 3 months ahead each time).<br>' +
        '3. That&rsquo;s it &mdash; nothing more to pay. Lessons are at ' + esc(ADDRESS) + '.<br>' +
        '<span style="color:' + C.muted + ';">Lost this link? Go to mcqmusiclessons.com.au, tap &ldquo;Use a Gift Voucher&rdquo; and enter your code. The code is all you need.</span>' +
      '</div>' +
    '</td></tr></table></td></tr></table>';
}

// ---------------------------------------------------------------- buyer: the voucher
function giftVoucherEmail(voucher) {
  const forName = voucher.recipientName;
  const redeemUrl = SITE + '/booking.html?voucher=' + encodeURIComponent(voucher.code) + '#package';
  const printUrl = SITE + '/voucher.html?code=' + encodeURIComponent(voucher.code);
  const subject = 'Your gift voucher' + (forName ? ' for ' + forName : '') + ' is ready';
  const body =
    h1('Your gift is ready') +
    p('Hi ' + esc(voucher.buyerName) + ',') +
    p('Thank you! Your gift voucher' + (forName ? ' for <strong>' + esc(forName) + '</strong>' : '') + ' is below, already paid for and ready to give.') +
    voucherCertificate(Object.assign({}, voucher, { redeemUrl: redeemUrl })) +
    h3('Giving it') +
    p('<strong>Print it:</strong> print this email, or open the print-friendly voucher page below and choose Print (or Save as PDF).<br>' +
      '<strong>Send it:</strong> forward this email, or send the voucher page link.<br>' +
      '<strong>Keep the code safe:</strong> anyone who has it can use the voucher, so hold on to it until you hand it over.') +
    button(printUrl, 'Open the printable voucher', true) +
    h3('Good to know') +
    p('&bull; It&rsquo;s valid until <strong>' + esc(niceDay(voucher.expiresAt)) + '</strong>, so there&rsquo;s no rush.<br>' +
      '&bull; The lessons are booked whenever suits &mdash; all at once, or a few at a time. Each time, dates can be up to 3 months ahead.<br>' +
      '&bull; They can choose guitar or piano, and move or cancel any lesson with at least 24 hours&rsquo; notice.<br>' +
      '&bull; Any questions at all, just reply to this email and it comes straight to me.') +
    p('Thanks again,<br><strong>James</strong>');
  const html = wrap({ title: subject, preheader: 'Print it, forward it or give the code: ' + voucher.lessonsTotal + ' x ' + voucher.durationMinutes + '-minute lessons' + (forName ? ' for ' + forName : '') + '.', bodyHtml: body });
  const text = [
    'Hi ' + voucher.buyerName + ',', '',
    'Thank you! Your gift voucher' + (forName ? ' for ' + forName : '') + ' is ready and already paid for.', '',
    '  GIFT VOUCHER - MCQ Music Lessons, South Melbourne',
    '  ' + voucher.lessonsTotal + ' music lessons, ' + voucher.durationMinutes + ' minutes each (guitar or piano)',
    forName ? '  For: ' + forName : null,
    voucher.buyerName ? '  From: ' + voucher.buyerName : null,
    voucher.message ? '  Message: "' + voucher.message + '"' : null,
    '  CODE: ' + voucher.code,
    '  Valid until ' + niceDay(voucher.expiresAt), '',
    'To use it: go to ' + SITE + '/booking.html#package, enter the code, and choose a date and time for each lesson (all at once or a few at a time, up to 3 months ahead each time). Nothing more to pay.',
    'Lost the link? Go to mcqmusiclessons.com.au, tap "Use a Gift Voucher" and enter the code. The code is all you need.', '',
    'Print-friendly voucher: ' + printUrl,
    'Book the lessons: ' + redeemUrl, '',
    'Anyone with the code can use it, so keep it safe until you give it. Lessons can be moved or cancelled with at least 24 hours\' notice.',
    'Any questions, just reply to this email.', '',
    'Thanks again,', 'James', '', 'MCQ Music Lessons, ' + ADDRESS + ' - 0499 232 898'
  ].filter(x => x !== null).join('\n');
  return { subject: subject, html: html, text: text };
}

// ---------------------------------------------------------------- James: a voucher was sold
function giftSoldEmailForJames(voucher) {
  const printUrl = SITE + '/voucher.html?code=' + encodeURIComponent(voucher.code);
  const subject = 'Gift voucher sold: ' + voucher.lessonsTotal + ' x ' + voucher.durationMinutes + ' min ($' + (voucher.pricePaidCents / 100) + ') - ' + voucher.buyerName;
  const body =
    h1('Gift voucher sold') +
    p('<strong>' + esc(voucher.buyerName) + '</strong> (<a href="mailto:' + esc(voucher.buyerEmail) + '" style="color:' + C.goldDark + ';">' + esc(voucher.buyerEmail) + '</a>) bought a gift voucher' + (voucher.recipientName ? ' for <strong>' + esc(voucher.recipientName) + '</strong>' : '') + '.') +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:14px;">' +
      '<tr><td style="padding:3px 18px 3px 0;color:' + C.muted + ';">Voucher</td><td>' + voucher.lessonsTotal + ' x ' + voucher.durationMinutes + '-minute lessons</td></tr>' +
      '<tr><td style="padding:3px 18px 3px 0;color:' + C.muted + ';">Paid</td><td>$' + (voucher.pricePaidCents / 100) + '</td></tr>' +
      '<tr><td style="padding:3px 18px 3px 0;color:' + C.muted + ';">Code</td><td><strong style="font-family:\'Courier New\',monospace;">' + esc(voucher.code) + '</strong></td></tr>' +
      '<tr><td style="padding:3px 18px 3px 0;color:' + C.muted + ';">Valid until</td><td>' + esc(niceDay(voucher.expiresAt)) + '</td></tr>' +
    '</table>' +
    (voucher.message ? p('Their message on the voucher: <em>&ldquo;' + esc(voucher.message) + '&rdquo;</em>') : '') +
    p('The voucher has been emailed to ' + esc(voucher.buyerName) + '. If it ever gets lost, this is the printable page: <a href="' + printUrl + '" style="color:' + C.goldDark + ';">' + esc(printUrl) + '</a>');
  const html = wrap({ title: subject, preheader: voucher.buyerName + ' bought a gift voucher.', bodyHtml: body });
  const text = [
    voucher.buyerName + ' (' + voucher.buyerEmail + ') bought a gift voucher' + (voucher.recipientName ? ' for ' + voucher.recipientName : '') + '.',
    voucher.lessonsTotal + ' x ' + voucher.durationMinutes + '-minute lessons, paid $' + (voucher.pricePaidCents / 100),
    'Code: ' + voucher.code + ' (valid until ' + niceDay(voucher.expiresAt) + ')',
    voucher.message ? 'Message: "' + voucher.message + '"' : null,
    'Printable page: ' + printUrl
  ].filter(x => x !== null).join('\n');
  return { subject: subject, html: html, text: text };
}

// ---------------------------------------------------------------- recipient: lessons booked with a voucher
function lessonsBookedEmail(o) {
  // o: { name, slots:[{date,time}], durationMinutes, instrument, guitarType, left, code }
  const sorted = o.slots.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const n = sorted.length;
  const subject = 'Your ' + (n === 1 ? 'lesson is' : n + ' lessons are') + ' booked' + (sorted[0] ? ': ' + niceDay(sorted[0].date) : '');
  const rows = sorted.map(s => '<tr><td style="padding:10px 14px;border-bottom:1px solid ' + C.line + ';font-weight:600;color:' + C.ink + ';">' + esc(niceDate(s.date)) + '</td><td style="padding:10px 14px;border-bottom:1px solid ' + C.line + ';">' + esc(s.time) + '</td><td style="padding:10px 14px;border-bottom:1px solid ' + C.line + ';color:' + C.muted + ';">' + esc(o.durationMinutes) + ' min</td></tr>').join('');
  const instrument = [o.instrument, (o.instrument !== 'Piano' && o.guitarType && o.guitarType !== 'Either') ? '(' + o.guitarType + ')' : ''].filter(Boolean).join(' ');
  const redeemUrl = SITE + '/booking.html?voucher=' + encodeURIComponent(o.code) + '#package';
  const body =
    h1(n === 1 ? 'Your lesson is booked' : 'Your lessons are booked') +
    p('Hi ' + esc(o.name) + ',') +
    p('Your ' + (n === 1 ? 'lesson is' : 'lessons are') + ' booked using your gift voucher. Nothing more to pay.') +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + C.line + ';border-radius:4px;font-size:14px;margin:6px 0 16px;">' + rows + '</table>' +
    p((instrument ? '<strong>Instrument:</strong> ' + esc(instrument) + '<br>' : '') + '<strong>Where:</strong> <a href="' + MAPS + '" style="color:' + C.goldDark + ';">' + esc(ADDRESS) + '</a>') +
    (o.left > 0
      ? p('You have <strong>' + o.left + ' lesson' + (o.left === 1 ? '' : 's') + ' left</strong> on your voucher. Whenever you&rsquo;re ready to book ' + (o.left === 1 ? 'it' : 'them') + ', use the button below (your code is <strong style="white-space:nowrap;">' + esc(o.code) + '</strong>).') + button(redeemUrl, 'Book my remaining lessons', true)
      : p('That was the last lesson on your voucher &mdash; enjoy it! If you&rsquo;d like to keep going, just reply and we&rsquo;ll set up a regular time.')) +
    p('Need to move or cancel a lesson? Use <a href="' + SITE + '/booking.html#manage" style="color:' + C.goldDark + ';">My Lessons</a> with at least 24 hours&rsquo; notice. Or just reply to this email.') +
    p('See you soon,<br><strong>James</strong>');
  const html = wrap({ title: subject, preheader: n + (n === 1 ? ' lesson' : ' lessons') + ' booked' + (sorted[0] ? ', starting ' + niceDay(sorted[0].date) + ' at ' + sorted[0].time : '') + '.', bodyHtml: body });
  const text = [
    'Hi ' + o.name + ',', '',
    'Your ' + (n === 1 ? 'lesson is' : 'lessons are') + ' booked using your gift voucher. Nothing more to pay.', '',
    ...sorted.map(s => '  ' + niceDate(s.date) + ' at ' + s.time + ' (' + o.durationMinutes + ' min)'), '',
    'Where: ' + ADDRESS,
    o.left > 0 ? 'You have ' + o.left + ' lesson' + (o.left === 1 ? '' : 's') + ' left on your voucher. Book ' + (o.left === 1 ? 'it' : 'them') + ' any time: ' + redeemUrl + ' (code ' + o.code + ')' : 'That was the last lesson on your voucher.',
    'To move or cancel a lesson (at least 24 hours\' notice): ' + SITE + '/booking.html#manage - or just reply to this email.', '',
    'See you soon,', 'James'
  ].join('\n');
  return { subject: subject, html: html, text: text };
}

// ---------------------------------------------------------------- James: voucher lessons were booked
function voucherBookedEmailForJames(o) {
  // o: { name, email, slots, durationMinutes, instrument, guitarType, skillLevel, left, code }
  const sorted = o.slots.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const subject = 'Voucher lessons booked: ' + o.name + ' (' + sorted.length + ')';
  const list = sorted.map(s => '<li>' + esc(niceDate(s.date)) + ' at ' + esc(s.time) + '</li>').join('');
  const body =
    h1('Voucher lessons booked') +
    p('<strong>' + esc(o.name) + '</strong> (<a href="mailto:' + esc(o.email) + '" style="color:' + C.goldDark + ';">' + esc(o.email) + '</a>) booked ' + sorted.length + ' lesson' + (sorted.length === 1 ? '' : 's') + ' with gift voucher <strong>' + esc(o.code) + '</strong> (' + o.left + ' left).') +
    '<ul style="margin:0 0 14px;padding-left:20px;">' + list + '</ul>' +
    p(esc([o.instrument, o.guitarType].filter(Boolean).join(' / ')) + (o.skillLevel ? ' &middot; ' + esc(o.skillLevel) : '') + ' &middot; ' + esc(o.durationMinutes) + ' min lessons. They are in your calendar.');
  const html = wrap({ title: subject, preheader: o.name + ' booked ' + sorted.length + ' voucher lesson(s).', bodyHtml: body });
  const text = [o.name + ' (' + o.email + ') booked ' + sorted.length + ' lesson(s) with gift voucher ' + o.code + ' (' + o.left + ' left):', ...sorted.map(s => '  ' + niceDate(s.date) + ' at ' + s.time), [o.instrument, o.guitarType, o.skillLevel].filter(Boolean).join(' / ')].join('\n');
  return { subject: subject, html: html, text: text };
}

module.exports = { esc, wrap, button, voucherCertificate, giftVoucherEmail, giftSoldEmailForJames, lessonsBookedEmail, voucherBookedEmailForJames, niceDate, niceDay };
