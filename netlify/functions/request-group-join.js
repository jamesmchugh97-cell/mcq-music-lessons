// request-group-join.js
// Netlify serverless function: a student asks to join a lesson that is open to a group class.
// Saves the request, emails the student who owns that lesson (with a private yes/no link), and
// tells James. Nothing is charged here.
const gh = require('./group-helpers');

function reply(status, obj) { return { statusCode: status, body: JSON.stringify(obj) }; }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { success: false, error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return reply(400, { success: false, error: 'Invalid request body' }); }

  if (await gh.overRequestLimit(event)) return reply(429, { success: false, error: 'Too many requests. Please try again in a while, or contact James.' });

  const name = gh.clean(body.name, 80);
  const email = gh.clean(body.email, 200).toLowerCase();
  const phone = gh.clean(body.phone, 40);
  const level = gh.clean(body.level, 40);
  const wantedInstrument = body.instrument === 'Piano' ? 'Piano' : (body.instrument === 'Guitar' ? 'Guitar' : '');
  const genres = gh.clean(body.genres, 200);
  const goals = gh.clean(body.goals, 300);
  const ageGroup = gh.cleanAge(body.ageGroup);
  if (!name) return reply(200, { success: false, error: 'Please enter your name.' });
  if (!gh.validEmail(email)) return reply(200, { success: false, error: 'Please enter a valid email address.' });
  if (!level) return reply(200, { success: false, error: 'Please choose your level.' });
  if (!ageGroup) return reply(200, { success: false, error: 'Please choose adult learner or young learner.' });

  try {
    const listings = await gh.getAllListings();
    const listing = listings.find(l => l.id === body.listingId);
    if (!listing || listing.status === 'taken') return reply(200, { success: false, error: 'Sorry, that lesson is no longer available. Please pick another.' });
    if (listing.status === 'pending') return reply(200, { success: false, error: 'Someone has already asked to join that lesson and it is waiting for a reply. Please pick another, or check back soon.' });
    if (!listing.ageGroup || listing.ageGroup !== ageGroup) return reply(200, { success: false, error: 'That class is for ' + (gh.ageWords(listing.ageGroup) || 'a different age group') + ' only. Please pick another.' });
    if (String(listing.ownerEmail || '').toLowerCase() === email) return reply(200, { success: false, error: 'That is your own lesson.' });
    // Anyone already in the class (paid up) must agree to a new student too.
    const existing = (await gh.listAllRequests()).filter(x => x.listingId === listing.id && x.status === 'active');
    if (existing.some(x => String(x.requester.email || '').toLowerCase() === email)) return reply(200, { success: false, error: 'You are already in that class.' });
    if (listing.members >= gh.MAX_GROUP) return reply(200, { success: false, error: 'Sorry, that class is full.' });

    const instrument = listing.instrument || wantedInstrument;
    if (!instrument) return reply(200, { success: false, error: 'Please choose guitar or piano.' });
    await gh.recordRequestAttempt(event);
    const id = gh.randomId();
    const request = {
      id: id, listingId: listing.id, status: 'pending', createdAt: new Date().toISOString(),
      token: gh.randomToken(),
      requester: { ageGroup: ageGroup, name: name, email: email, phone: phone, level: level, genres: genres, goals: goals },
      lesson: {
        ownerName: listing.ownerName || listing.ownerFirstName, ownerEmail: listing.ownerEmail, firstName: listing.ownerFirstName || listing.firstName,
        instrument: instrument, dayName: gh.DAY_NAMES[listing.dayOfWeek], time: listing.time, dayOfWeek: listing.dayOfWeek,
        durationMinutes: listing.durationMinutes, frequency: listing.frequency,
        ageGroup: listing.ageGroup, ownerSubscriptionId: listing.subscriptionId || '', ownerIsRoster: listing.source === 'roster'
      }
    };
    // Everyone already in the class has to say yes: the lesson's owner (unless they have left) and each student who has joined.
    request.approvals = [];
    if (!existing.some(x => x.ownerLeft)) request.approvals.push({ role: 'owner', name: request.lesson.ownerName, email: listing.ownerEmail, token: request.token, status: 'pending' });
    existing.forEach(x => request.approvals.push({ role: 'member', name: x.requester.name, email: x.requester.email, token: gh.randomToken(), status: 'pending' }));
    if (!request.approvals.length) return reply(200, { success: false, error: 'Sorry, that lesson is not available right now. Please pick another.' });
    await gh.requestsStore().set('req_' + id, JSON.stringify(request));

    const l = request.lesson;
    const when = l.dayName + 's at ' + l.time + ' (' + l.durationMinutes + ' min, ' + l.frequency + ')';
    const rule = gh.groupRuleText(l.durationMinutes);
    const linkFor = (t) => gh.SITE + '/group-response.html?t=' + t;
    const asking = request.approvals.length;
    let ownerOk = !request.approvals.some(a => a.role === 'owner');
    for (const ap of request.approvals) {
      const link = linkFor(ap.token);
      const buttons = '<p>' + gh.emailButton(link + '&a=approve', 'Yes, happy to share', true) + gh.emailButton(link + '&a=decline', 'No thanks', false) + '</p>';
      const who = gh.detailRows([['Name', gh.firstNameOf(name)], ['Level', level], ['Music they like', genres], ['Their goals', goals]]);
      let ok;
      if (ap.role === 'owner' && l.ownerIsRoster) {
        // Not enrolled online, so there is no email for them: James is asked, and asks them in person.
        ok = await gh.sendMail(gh.JAMES_EMAIL, 'Group class request for ' + l.ownerName + '\'s ' + l.dayName + ' ' + l.time + ' lesson: ask them in person',
          gh.wrapEmail('<p>Someone would like to share <strong>' + gh.esc(l.ownerName) + '\'s</strong> lesson as a group class. Please ask ' + gh.esc(l.ownerName) + ' in person, then answer here.</p>' +
            gh.detailRows([['Lesson', l.instrument + ', ' + when], ['Who wants to join', name + ' (' + email + (phone ? ', ' + phone : '') + ')'], ['Level', level], ['Music they like', genres], ['Their goals', goals]]) +
            '<p>' + gh.esc(rule) + '</p>' + (asking > 1 ? '<p>There is already another student in this class, so they are being asked too. Everyone has to agree.</p>' : '') + buttons));
      } else if (ap.role === 'owner') {
        ok = ap.email ? await gh.sendMail(ap.email, 'Someone would like to join your ' + l.instrument.toLowerCase() + ' lesson',
          gh.wrapEmail('<p>Hi ' + gh.esc(l.firstName) + ',</p>' +
            '<p>Would you be open to ' + (asking > 1 ? 'a third student joining' : 'sharing') + ' your ' + gh.esc(when) + ' lesson' + (asking > 1 ? '' : ' with another student as a group class') + '? Someone would like to join' + (asking > 1 ? ' you and the other student in the class. Everyone has to agree.' : ' you:') + '</p>' + who +
            '<p><strong>The price:</strong> ' + gh.esc(rule) + (asking > 1 ? ' Your price does not change when a third student joins.' : ' Your lesson stays at its current price unless the group goes ahead.') + '</p>' +
            '<p>Nothing changes unless ' + (asking > 1 ? 'everyone says yes' : 'you say yes') + '. If it goes ahead, they are asked to confirm and pay' + (asking > 1 ? '.' : ', and your price drops to the group price from your next payment.') + '</p>' + buttons +
            '<p style="color:#7b8496;font-size:14px;">Or open this link to see the details first: ' + gh.esc(link) + '</p>')) : false;
      } else {
        ok = await gh.sendMail(ap.email, 'A third student would like to join your ' + l.instrument.toLowerCase() + ' class',
          gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(ap.name)) + ',</p>' +
            '<p>A student would like to join your ' + gh.esc(when) + ' group class as the third student. Everyone in the class has to agree.</p>' + who +
            '<p><strong>The price:</strong> ' + gh.esc(rule) + ' Your price does not change when a third student joins.</p>' + buttons));
      }
      if (ap.role === 'owner') ownerOk = ok;
    }

    if (!l.ownerIsRoster) await gh.sendMail(
      gh.JAMES_EMAIL,
      'Group class request: ' + name + ' wants to join ' + l.firstName + '\'s lesson',
      gh.wrapEmail(
        '<p>New group class request' + (asking > 1 ? ' (a third student, so everyone in the class is being asked)' : '') + '.</p>' +
        gh.detailRows([['Lesson', l.instrument + ', ' + when], ['Owner', (l.ownerName || l.firstName) + ' (' + (l.ownerEmail || 'no email on file') + ')'],
          ['Wants to join', name + ' (' + email + (phone ? ', ' + phone : '') + ')'], ['Level', level], ['Music', genres], ['Goals', goals]]) +
        (ownerOk ? '<p>An email asking for a yes or no has been sent.</p>' : '<p><strong>No email could be sent to the lesson owner. Please contact them yourself.</strong></p>'))
    );

    await gh.sendMail(
      email,
      'We have your group class request',
      gh.wrapEmail(
        '<p>Hi ' + gh.esc(gh.firstNameOf(name)) + ',</p>' +
        '<p>Thanks for asking to join a ' + gh.esc(l.instrument.toLowerCase()) + ' group class on ' + gh.esc(when) + '.</p>' +
        '<p>We have asked ' + (asking > 1 ? 'the students in that class. They all need to say yes' : 'the student who currently has that time if they are happy to share it') + '. You will get an email as soon as they reply. You are not charged anything yet.</p>' +
        '<p><strong>Good to know:</strong> ' + gh.esc(rule) + '</p>')
    );

    return reply(200, { success: true });
  } catch (e) {
    console.error('[request-group-join] error:', e && e.message ? e.message : e);
    return reply(500, { success: false, error: 'Something went wrong. Nothing was sent. Please try again or contact James.' });
  }
};
