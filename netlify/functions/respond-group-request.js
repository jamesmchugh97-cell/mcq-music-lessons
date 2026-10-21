// respond-group-request.js
// Netlify serverless function: the student who owns a lesson says yes or no to a request to
// join it, using the private link emailed to them. Both students and James are told the result.
const gh = require('./group-helpers');

function reply(status, obj) { return { statusCode: status, body: JSON.stringify(obj) }; }

async function findByToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const all = await gh.listAllRequests();
  for (const r of all) {
    if (Array.isArray(r.approvals)) {
      const ap = r.approvals.find(a => a.token === token);
      if (ap) return { r: r, ap: ap };
    } else if (r.token === token) {
      // A request made before groups could have three students: the owner is the only one asked.
      r.approvals = [{ role: 'owner', name: r.lesson.ownerName, email: r.lesson.ownerEmail, token: r.token, status: r.status }];
      return { r: r, ap: r.approvals[0] };
    }
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { success: false, error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return reply(400, { success: false, error: 'Invalid request body' }); }

  try {
    const found = await findByToken(body.token);
    if (!found) return reply(200, { success: false, error: 'This link is not valid any more.' });
    const r = found.r, ap = found.ap;
    const l = r.lesson;
    const when = l.dayName + 's at ' + l.time + ' (' + l.durationMinutes + ' min, ' + l.frequency + ')';
    const view = {
      status: r.status, myStatus: ap.status === 'approved' && r.status === 'pending' ? 'approved' : r.status, isOwner: ap.role === 'owner', isThird: r.approvals.length > 1 || ap.role === 'member',
      myFirstName: gh.firstNameOf(ap.name),
       firstName: l.firstName, instrument: l.instrument, when: when, isRoster: !!l.ownerIsRoster, ownerName: l.ownerName,
      rule: gh.groupRuleText(l.durationMinutes),
      requester: { firstName: gh.firstNameOf(r.requester.name), level: r.requester.level, genres: r.requester.genres, goals: r.requester.goals }
    };

    if (body.action === 'view' || !body.action) return reply(200, { success: true, request: view });

    if (body.action !== 'approve' && body.action !== 'decline') return reply(200, { success: false, error: 'Unknown action.' });
    if (r.status !== 'pending' || ap.status !== 'pending') return reply(200, { success: true, request: view, alreadyDone: true });

    if (body.action === 'approve') {
      // Re-check nobody else got approved for this lesson in the meantime.
      const all = await gh.listAllRequests();
      const others = all.filter(x => x.listingId === r.listingId && (x.status === 'approved' || x.status === 'active') && x.id !== r.id).length;
      const ownerGone = all.some(x => x.listingId === r.listingId && x.status === 'active' && x.ownerLeft);
      if ((ownerGone ? 0 : 1) + others + 1 > gh.MAX_GROUP) {
        return reply(200, { success: false, error: 'Sorry, that class filled up first. James will be in touch.' });
      }
    }
    ap.status = body.action === 'approve' ? 'approved' : 'declined';
    ap.respondedAt = new Date().toISOString();
    const everyoneYes = r.approvals.every(a => a.status === 'approved');
    r.status = body.action === 'decline' ? 'declined' : (everyoneYes ? 'approved' : 'pending');
    if (r.status !== 'pending') r.respondedAt = new Date().toISOString();
    await gh.requestsStore().set('req_' + r.id, JSON.stringify(r));
    view.status = r.status;
    view.myStatus = r.status === 'pending' ? ap.status : r.status;
    // One yes is not enough when others still have to answer.
    if (r.status === 'pending') {
      await gh.sendMail(gh.JAMES_EMAIL, 'Group class: ' + (ap.name || ap.role) + ' said yes, waiting on the others',
        gh.wrapEmail('<p>' + gh.esc(ap.name || 'A student') + ' agreed to ' + gh.esc(r.requester.name) + ' joining ' + gh.esc(l.instrument + ', ' + when) + '. Still waiting on: ' + gh.esc(r.approvals.filter(a => a.status === 'pending').map(a => a.name || a.role).join(', ')) + '.</p>'));
      return reply(200, { success: true, request: view });
    }

    const rq = r.requester;
    if (r.status === 'approved') {
      r.payToken = gh.randomToken();
      await gh.requestsStore().set('req_' + r.id, JSON.stringify(r));
      const payLink = gh.SITE + '/group-join.html?p=' + r.payToken;
      const rule = gh.groupRuleText(l.durationMinutes);
      await gh.sendMail(rq.email, 'Good news: you can join the group class',
        gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(rq.name)) + ',</p><p>The ' + (r.approvals.length > 1 ? 'students you asked have all said yes' : 'student you asked has said yes') + '. You can share the ' + gh.esc(l.instrument.toLowerCase()) + ' lesson on ' + gh.esc(when) + '.</p>' +
          '<p><strong>Price:</strong> ' + gh.esc(rule) + '</p>' +
          '<p>To lock in your spot, confirm and set up your payment here. You are not charged until you do.</p>' +
          '<p>' + gh.emailButton(payLink, 'Confirm and pay', true) + '</p>'));
      const third = r.approvals.length > 1;
      for (const a of r.approvals) {
        if (!a.email || (a.role === 'owner' && l.ownerIsRoster)) continue;
        await gh.sendMail(a.email, third ? 'Everyone agreed: a third student is joining' : 'Thanks for sharing your lesson',
          gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(a.name)) + ',</p><p>' + (third
            ? 'Thanks, everyone in the class said yes. Once the new student confirms and pays, they join your ' + gh.esc(when) + ' class. Your price stays at the group price.'
            : 'Thanks for saying yes. Once the other student confirms and pays, your ' + gh.esc(when) + ' lesson moves to the group price from your next payment.') + '</p>' +
            '<p>' + gh.esc(gh.groupRuleText(l.durationMinutes)) + ' You will be emailed if that changes.</p>'));
      }
      await gh.sendMail(gh.JAMES_EMAIL, 'Group class approved: ' + rq.name + ' joining ' + (l.ownerName || l.firstName),
        gh.wrapEmail('<p><strong>' + gh.esc(l.ownerName || l.firstName) + ' said yes.</strong> ' + gh.esc(rq.name) + ' has been emailed a link to confirm and pay. Billing and price changes are automatic' + (l.ownerIsRoster ? ', except ' + gh.esc(l.ownerName) + '\'s own price, which you handle in person.' : '.') + '</p>' +
          gh.detailRows([['Lesson', l.instrument + ', ' + when], ['Owner', (l.ownerName || l.firstName) + ' (' + (l.ownerIsRoster ? 'regular student, not enrolled online' : (l.ownerEmail || 'no email')) + ')'], ['Joining', rq.name + ' (' + rq.email + (rq.phone ? ', ' + rq.phone : '') + ')'], ['Level', rq.level], ['Music', rq.genres], ['Goals', rq.goals]])));
    } else {
      await gh.sendMail(rq.email, 'About your group class request',
        gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(rq.name)) + ',</p><p>Thanks for asking to join the ' + gh.esc(l.instrument.toLowerCase()) + ' lesson on ' + gh.esc(when) + '. Unfortunately ' + (r.approvals.length > 1 ? 'the students in that class would rather keep it as it is' : 'that student would rather keep it as it is') + '.</p>' +
          '<p>There may be other group lessons that suit you: <a href="' + gh.esc(gh.SITE) + '/booking.html#group">see what is open</a>. Or reply to this email and James will help find a good time.</p>'));
      await gh.sendMail(gh.JAMES_EMAIL, 'Group class declined: ' + (ap.name || l.firstName) + ' said no to ' + rq.name,
        gh.wrapEmail('<p>' + gh.esc(ap.name || l.firstName) + ' declined the request from ' + gh.esc(rq.name) + ' (' + gh.esc(rq.email) + ') for ' + gh.esc(l.instrument) + ', ' + gh.esc(when) + '. The lesson stays open to new requests.</p>'));
    }
    return reply(200, { success: true, request: view });
  } catch (e) {
    console.error('[respond-group-request] error:', e && e.message ? e.message : e);
    return reply(500, { success: false, error: 'Something went wrong. Please try again or contact James.' });
  }
};
