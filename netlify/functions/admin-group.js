// admin-group.js
// Netlify serverless function: lets James open one of his regular lessons to a group class by
// hand (for students who were not enrolled through the website), take one off again, and see
// every group request. Protected by the same admin password and lockout as the other admin tools.
const { checkAdmin } = require('./admin-auth-helper');
const Stripe = require('stripe');
const gh = require('./group-helpers');
const groupBilling = require('./group-billing');

function fail(status, error) { return { statusCode: status, body: JSON.stringify({ success: false, error: error }) }; }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return fail(400, 'Invalid request body'); }
  const auth = await checkAdmin(event, body.password);
  if (!auth.ok) return fail(auth.status, auth.error);

  try {
    if (body.action === 'add') {
      const firstName = gh.clean(body.firstName, 40);
      const ownerEmail = gh.clean(body.ownerEmail, 200).toLowerCase();
      const dow = parseInt(body.dayOfWeek, 10);
      const duration = parseInt(body.durationMinutes, 10);
      if (!firstName) return fail(400, 'Please enter their first name.');
      if (!gh.validEmail(ownerEmail)) return fail(400, 'Please enter their email (it is how they are asked to say yes or no).');
      if (!(dow >= 1 && dow <= 5)) return fail(400, 'Please choose a day, Monday to Friday.');
      if (!body.time) return fail(400, 'Please enter the lesson time.');
      if (!(duration >= 15 && duration <= 120)) return fail(400, 'Please enter the lesson length in minutes.');
      const instrument = body.instrument === 'Piano' ? 'Piano' : 'Guitar';
      const id = 'm' + gh.randomId();
      const listing = {
        id: id, active: true, createdAt: new Date().toISOString(),
        firstName: firstName, ownerName: gh.clean(body.ownerName, 80) || firstName, ownerEmail: ownerEmail,
        ageGroup: gh.cleanAge(body.ageGroup), instrument: instrument, level: gh.clean(body.level, 40), genres: gh.clean(body.genres, 200), goals: gh.clean(body.goals, 300),
        dayOfWeek: dow, time: gh.clean(body.time, 12), durationMinutes: duration, frequency: body.frequency === 'fortnightly' ? 'fortnightly' : 'weekly'
      };
      await gh.listingsStore().set('lst_' + id, JSON.stringify(listing));
      return { statusCode: 200, body: JSON.stringify({ success: true, id: id }) };
    }
    // A student cancelled a group lesson in time, so fewer students attend than the price was set for.
    // Each student who does attend is charged the difference on their next payment.
    if (body.action === 'shortLesson') {
      const id = gh.clean(body.id, 40);
      const date = gh.clean(body.date, 12);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, 'Please enter the lesson date like 2026-11-04.');
      const cancelledNames = String(body.cancelled || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (!id || !cancelledNames.length) return fail(400, 'Please enter the lesson id and the first name of each student who cancelled.');
      const reqs = await gh.listAllRequests();
      const r = reqs.find(x => x.listingId === id && x.status === 'active');
      if (!r) return fail(404, 'No group class with paid students found for that lesson id.');
      const { members } = await groupBilling.membersOf(r);
      const isCancelled = m => cancelledNames.some(n => gh.firstNameOf(m.name).toLowerCase() === n || String(m.name || '').toLowerCase() === n);
      const away = members.filter(isCancelled), attending = members.filter(m => !isCancelled(m));
      if (away.length !== cancelledNames.length) return fail(400, 'I could not match every name to a student in that class. Class members: ' + members.map(m => gh.firstNameOf(m.name)).join(', ') + '.');
      if (!attending.length) return fail(400, 'Nobody would be attending, so nothing to charge.');
      const l = r.lesson;
      const paid = gh.priceForSize(l.durationMinutes, members.length), fair = gh.priceForSize(l.durationMinutes, attending.length);
      const topup = Math.max(0, fair - paid);
      const plan = attending.map(m => ({ name: m.name, billable: !!m.subscriptionId, topup: m.subscriptionId ? topup : 0, note: m.roster ? 'Regular student not enrolled online: charge them in person.' : '' }));
      if (body.confirm !== true) return { statusCode: 200, body: JSON.stringify({ success: true, preview: true, expected: members.length, attending: attending.length, paidEach: gh.dollars(paid), fairEach: gh.dollars(fair), topupEach: gh.dollars(topup), plan: plan }) };
      if (!topup) return { statusCode: 200, body: JSON.stringify({ success: true, applied: [], message: 'No extra charge needed.' }) };
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      const store = gh.listingsStore();
      const applied = [];
      for (const m of attending) {
        if (!m.subscriptionId) continue;
        const key = 'topup_' + id + '_' + date + '_' + m.subscriptionId;
        if (await store.get(key, { type: 'json' })) { applied.push({ name: m.name, skipped: 'already charged for this date' }); continue; }
        const sub = await stripe.subscriptions.retrieve(m.subscriptionId);
        await stripe.invoiceItems.create({ customer: sub.customer, subscription: m.subscriptionId, amount: topup, currency: 'aud',
          description: 'Group lesson ' + date + ': ' + attending.length + ' student' + (attending.length === 1 ? '' : 's') + ' attended, price difference' });
        await store.set(key, JSON.stringify({ at: new Date().toISOString(), amount: topup }));
        applied.push({ name: m.name, amount: gh.dollars(topup) });
        if (m.email) await gh.sendMail(m.email, 'A small change to your next group lesson payment',
          gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(m.name)) + ',</p><p>For your ' + gh.esc(l.dayName + 's at ' + l.time) + ' lesson on ' + gh.esc(date) + ', ' + (away.length === 1 ? 'one student' : away.length + ' students') + ' cancelled in time, so fewer students are attending. The price depends on how many attend, so ' + gh.esc(gh.dollars(topup)) + ' will be added to your next payment.</p><p>' + gh.esc(gh.groupRuleText(l.durationMinutes)) + '</p>'));
      }
      return { statusCode: 200, body: JSON.stringify({ success: true, applied: applied, plan: plan }) };
    }
    if (body.action === 'setAge') {
      const id = gh.clean(body.id, 40);
      if (!id) return fail(400, 'Please enter the lesson id.');
      const age = gh.cleanAge(body.ageGroup);
      await gh.listingsStore().set('age_' + id, JSON.stringify({ ageGroup: age }));
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }
    if (body.action === 'remove') {
      const id = gh.clean(body.id, 40);
      const store = gh.listingsStore();
      const l = await store.get('lst_' + id, { type: 'json' });
      if (!l) return fail(404, 'No such listing.');
      l.active = false;
      await store.set('lst_' + id, JSON.stringify(l));
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }
    if (body.action === 'list') {
      const all = await gh.getAllListings();
      const reqs = await gh.listAllRequests();
      const lines = all.map(l => ({ id: l.id, source: l.source, firstName: l.ownerFirstName || l.firstName, instrument: l.instrument, day: gh.DAY_NAMES[l.dayOfWeek], time: l.time, durationMinutes: l.durationMinutes, status: l.status, ageGroup: l.ageGroup || '' }));
      const requests = reqs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30)
        .map(r => ({ status: r.status, createdAt: r.createdAt, who: r.requester.name, email: r.requester.email, lesson: r.lesson.firstName + ', ' + r.lesson.dayName + ' ' + r.lesson.time }));
      return { statusCode: 200, body: JSON.stringify({ success: true, listings: lines, requests: requests }) };
    }
    return fail(400, 'Unknown action.');
  } catch (e) {
    console.error('[admin-group] error:', e && e.message ? e.message : e);
    return fail(500, 'Something went wrong. Nothing further was changed.');
  }
};
