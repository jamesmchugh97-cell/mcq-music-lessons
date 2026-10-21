// respond-group-request.js
// Netlify serverless function: the student who owns a lesson says yes or no to a request to
// join it, using the private link emailed to them. Both students and James are told the result.
const gh = require('./group-helpers');

function reply(status, obj) { return { statusCode: status, body: JSON.stringify(obj) }; }

async function findByToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const all = await gh.listAllRequests();
  return all.find(r => r.token === token) || null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { success: false, error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return reply(400, { success: false, error: 'Invalid request body' }); }

  try {
    const r = await findByToken(body.token);
    if (!r) return reply(200, { success: false, error: 'This link is not valid any more.' });
    const l = r.lesson;
    const when = l.dayName + 's at ' + l.time + ' (' + l.durationMinutes + ' min, ' + l.frequency + ')';
    const view = {
      status: r.status, firstName: l.firstName, instrument: l.instrument, when: when,
      requester: { firstName: gh.firstNameOf(r.requester.name), level: r.requester.level, genres: r.requester.genres, goals: r.requester.goals }
    };

    if (body.action === 'view' || !body.action) return reply(200, { success: true, request: view });

    if (body.action !== 'approve' && body.action !== 'decline') return reply(200, { success: false, error: 'Unknown action.' });
    if (r.status !== 'pending') return reply(200, { success: true, request: view, alreadyDone: true });

    if (body.action === 'approve') {
      // Re-check nobody else got approved for this lesson in the meantime.
      const all = await gh.listAllRequests();
      if (all.some(x => x.listingId === r.listingId && x.status === 'approved' && x.id !== r.id)) {
        return reply(200, { success: false, error: 'Sorry, someone else was approved for this lesson first. James will be in touch.' });
      }
    }
    r.status = body.action === 'approve' ? 'approved' : 'declined';
    r.respondedAt = new Date().toISOString();
    await gh.requestsStore().set('req_' + r.id, JSON.stringify(r));
    view.status = r.status;

    const rq = r.requester;
    if (r.status === 'approved') {
      await gh.sendMail(rq.email, 'Good news: your group class is on',
        gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(rq.name)) + ',</p><p>The student you asked has said yes. You can share the ' + gh.esc(l.instrument.toLowerCase()) + ' lesson on ' + gh.esc(when) + '.</p>' +
          '<p>James will email you shortly with the group price and the start date. You are not charged until you have confirmed with him.</p>'));
      if (l.ownerEmail) await gh.sendMail(l.ownerEmail, 'Thanks for sharing your lesson',
        gh.wrapEmail('<p>Hi ' + gh.esc(l.firstName) + ',</p><p>Thanks for saying yes. James will be in touch about the group price for your ' + gh.esc(when) + ' lesson before anything changes.</p>'));
      await gh.sendMail(gh.JAMES_EMAIL, 'Group class approved: ' + rq.name + ' joining ' + l.firstName,
        gh.wrapEmail('<p><strong>' + gh.esc(l.firstName) + ' said yes.</strong> Next step: confirm the group price and start date with both students, and update the calendar and billing.</p>' +
          gh.detailRows([['Lesson', l.instrument + ', ' + when], ['Owner', (l.ownerName || l.firstName) + ' (' + (l.ownerEmail || 'no email') + ')'], ['Joining', rq.name + ' (' + rq.email + (rq.phone ? ', ' + rq.phone : '') + ')'], ['Level', rq.level], ['Music', rq.genres], ['Goals', rq.goals]])));
    } else {
      await gh.sendMail(rq.email, 'About your group class request',
        gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(rq.name)) + ',</p><p>Thanks for asking to join the ' + gh.esc(l.instrument.toLowerCase()) + ' lesson on ' + gh.esc(when) + '. Unfortunately that student would rather keep it as it is.</p>' +
          '<p>There may be other group lessons that suit you: <a href="' + gh.esc(gh.SITE) + '/booking.html#group">see what is open</a>. Or reply to this email and James will help find a good time.</p>'));
      await gh.sendMail(gh.JAMES_EMAIL, 'Group class declined: ' + l.firstName + ' said no to ' + rq.name,
        gh.wrapEmail('<p>' + gh.esc(l.firstName) + ' declined the request from ' + gh.esc(rq.name) + ' (' + gh.esc(rq.email) + ') for ' + gh.esc(l.instrument) + ', ' + gh.esc(when) + '. The lesson stays open to new requests.</p>'));
    }
    return reply(200, { success: true, request: view });
  } catch (e) {
    console.error('[respond-group-request] error:', e && e.message ? e.message : e);
    return reply(500, { success: false, error: 'Something went wrong. Please try again or contact James.' });
  }
};
