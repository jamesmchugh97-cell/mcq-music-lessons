// create-group-checkout.js
// Netlify serverless function: for a student whose request to join a group class has been
// approved. 'view' returns what the confirm page shows; 'pay' creates the Stripe Checkout for the
// recurring group price. The private link in their email is the only way in.
const Stripe = require('stripe');
const gh = require('./group-helpers');
const { nextOccurrenceDate } = require('./subscription-helpers');

function reply(status, obj) { return { statusCode: status, body: JSON.stringify(obj) }; }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { success: false, error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return reply(400, { success: false, error: 'Invalid request body' }); }
  const token = String(body.token || '');
  if (!/^[a-f0-9]{48}$/.test(token)) return reply(200, { success: false, error: 'This link is not valid any more.' });

  try {
    const all = await gh.listAllRequests();
    const r = all.find(x => x.payToken === token);
    if (!r) return reply(200, { success: false, error: 'This link is not valid any more.' });
    const l = r.lesson;
    const sizeNow = (await require('./group-billing').membersOf(r)).members.length + 1;
    const g = gh.priceForSize(l.durationMinutes, Math.max(2, sizeNow)), p = gh.privateCents(l.durationMinutes);
    if (!g || !p) return reply(200, { success: false, error: 'Sorry, we could not work out the price. Please contact James.' });
    if (r.status === 'approved' && !gh.approvalHolds(r)) return reply(200, { success: false, error: 'This link has expired because it was not used within ' + gh.APPROVAL_DAYS + ' days. Please ask to join again, or contact James.' });
    const firstLesson = nextOccurrenceDate(l.dayOfWeek, l.time, 24, null);
    const view = {
      status: r.status, firstName: gh.firstNameOf(r.requester.name), instrument: l.instrument, dayName: l.dayName, time: l.time,
      durationMinutes: l.durationMinutes, frequency: l.frequency, groupPrice: gh.dollars(g), privatePrice: gh.dollars(p),
      rule: gh.groupRuleText(l.durationMinutes), firstLesson: firstLesson
    };
    if (body.action !== 'pay') return reply(200, { success: true, request: view });

    if (r.status !== 'approved') return reply(200, { success: false, error: r.status === 'active' ? 'You are already booked in. Thanks!' : 'This link is no longer active. Please contact James.' });
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const site = process.env.URL || gh.SITE;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: r.requester.email,
      line_items: [{ quantity: 1, price_data: {
        currency: 'aud', unit_amount: g,
        product_data: { name: 'Group ' + l.instrument.toLowerCase() + ' lesson, ' + l.durationMinutes + ' min (' + l.dayName + 's at ' + l.time + ')' },
        recurring: { interval: 'week', interval_count: l.frequency === 'fortnightly' ? 2 : 1 }
      } }],
      subscription_data: { metadata: {
        groupJoin: 'yes', requestId: r.id, studentName: r.requester.name, studentEmail: r.requester.email,
        instrument: l.instrument, durationMinutes: String(l.durationMinutes), frequency: l.frequency, dayOfWeek: String(l.dayOfWeek), time: l.time
      } },
      custom_text: { submit: { message: gh.groupRuleText(l.durationMinutes) } },
      success_url: site + '/group-join.html?p=' + token + '&paid=1',
      cancel_url: site + '/group-join.html?p=' + token
    });
    return reply(200, { success: true, url: session.url });
  } catch (e) {
    console.error('[create-group-checkout] error:', e && e.message ? e.message : e);
    return reply(500, { success: false, error: 'Something went wrong. You have not been charged. Please try again or contact James.' });
  }
};
