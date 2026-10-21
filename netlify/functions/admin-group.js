// admin-group.js
// Netlify serverless function: lets James open one of his regular lessons to a group class by
// hand (for students who were not enrolled through the website), take one off again, and see
// every group request. Protected by the same admin password and lockout as the other admin tools.
const { checkAdmin } = require('./admin-auth-helper');
const gh = require('./group-helpers');

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
        instrument: instrument, level: gh.clean(body.level, 40), genres: gh.clean(body.genres, 200), goals: gh.clean(body.goals, 300),
        dayOfWeek: dow, time: gh.clean(body.time, 12), durationMinutes: duration, frequency: body.frequency === 'fortnightly' ? 'fortnightly' : 'weekly'
      };
      await gh.listingsStore().set('lst_' + id, JSON.stringify(listing));
      return { statusCode: 200, body: JSON.stringify({ success: true, id: id }) };
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
      const lines = all.map(l => ({ id: l.id, source: l.source, firstName: l.firstName, instrument: l.instrument, day: gh.DAY_NAMES[l.dayOfWeek], time: l.time, durationMinutes: l.durationMinutes, status: l.status }));
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
