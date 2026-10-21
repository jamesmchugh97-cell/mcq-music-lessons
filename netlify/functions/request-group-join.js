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
  if (!name) return reply(200, { success: false, error: 'Please enter your name.' });
  if (!gh.validEmail(email)) return reply(200, { success: false, error: 'Please enter a valid email address.' });
  if (!level) return reply(200, { success: false, error: 'Please choose your level.' });

  try {
    const listings = await gh.getAllListings();
    const listing = listings.find(l => l.id === body.listingId);
    if (!listing || listing.status === 'taken') return reply(200, { success: false, error: 'Sorry, that lesson is no longer available. Please pick another.' });
    if (listing.status === 'pending') return reply(200, { success: false, error: 'Someone has already asked to join that lesson and it is waiting for a reply. Please pick another, or check back soon.' });
    if (String(listing.ownerEmail || '').toLowerCase() === email) return reply(200, { success: false, error: 'That is your own lesson.' });

    const instrument = listing.instrument || wantedInstrument;
    if (!instrument) return reply(200, { success: false, error: 'Please choose guitar or piano.' });
    await gh.recordRequestAttempt(event);
    const id = gh.randomId();
    const request = {
      id: id, listingId: listing.id, status: 'pending', createdAt: new Date().toISOString(),
      token: gh.randomToken(),
      requester: { name: name, email: email, phone: phone, level: level, genres: genres, goals: goals },
      lesson: {
        ownerName: listing.ownerName || listing.ownerFirstName, ownerEmail: listing.ownerEmail, firstName: listing.ownerFirstName || listing.firstName,
        instrument: instrument, dayName: gh.DAY_NAMES[listing.dayOfWeek], time: listing.time, dayOfWeek: listing.dayOfWeek,
        durationMinutes: listing.durationMinutes, frequency: listing.frequency,
        ownerSubscriptionId: listing.subscriptionId || '', ownerIsRoster: listing.source === 'roster'
      }
    };
    await gh.requestsStore().set('req_' + id, JSON.stringify(request));

    const l = request.lesson;
    const link = gh.SITE + '/group-response.html?t=' + request.token;
    const when = l.dayName + 's at ' + l.time + ' (' + l.durationMinutes + ' min, ' + l.frequency + ')';
    const rule = gh.groupRuleText(l.durationMinutes);
    let ownerOk;
    if (l.ownerIsRoster) {
      // Not enrolled online, so there is no email for them: James is asked, and asks them in person.
      ownerOk = await gh.sendMail(
        gh.JAMES_EMAIL,
        'Group class request for ' + l.ownerName + '\'s ' + l.dayName + ' ' + l.time + ' lesson: ask them in person',
        gh.wrapEmail(
          '<p>Someone would like to share <strong>' + gh.esc(l.ownerName) + '\'s</strong> lesson as a group class. Please ask ' + gh.esc(l.ownerName) + ' in person, then answer here.</p>' +
          gh.detailRows([['Lesson', l.instrument + ', ' + when], ['Who wants to join', name + ' (' + email + (phone ? ', ' + phone : '') + ')'], ['Level', level], ['Music they like', genres], ['Their goals', goals]]) +
          '<p>' + gh.esc(rule) + '</p>' +
          '<p>' + gh.emailButton(link + '&a=approve', 'Yes, they are happy to share', true) + gh.emailButton(link + '&a=decline', 'No, they would rather not', false) + '</p>'));
    } else {
      ownerOk = listing.ownerEmail ? await gh.sendMail(
        listing.ownerEmail,
        'Someone would like to join your ' + l.instrument.toLowerCase() + ' lesson',
        gh.wrapEmail(
          '<p>Hi ' + gh.esc(l.firstName) + ',</p>' +
          '<p>Would you be open to sharing your ' + gh.esc(when) + ' lesson with another student as a group class? Someone would like to join you:</p>' +
          gh.detailRows([['Name', gh.firstNameOf(name)], ['Level', level], ['Music they like', genres], ['Their goals', goals]]) +
          '<p><strong>The price:</strong> ' + gh.esc(rule) + ' Your lesson stays at its current price unless the group goes ahead.</p>' +
          '<p>Nothing changes unless you say yes. If you do, they are asked to confirm and pay, and your price drops to the group price from your next payment.</p>' +
          '<p>' + gh.emailButton(link + '&a=approve', 'Yes, happy to share', true) + gh.emailButton(link + '&a=decline', 'No thanks', false) + '</p>' +
          '<p style="color:#7b8496;font-size:14px;">Or open this link to see the details first: ' + gh.esc(link) + '</p>')
      ) : false;
    }

    if (!l.ownerIsRoster) await gh.sendMail(
      gh.JAMES_EMAIL,
      'Group class request: ' + name + ' wants to join ' + l.firstName + '\'s lesson',
      gh.wrapEmail(
        '<p>New group class request.</p>' +
        gh.detailRows([['Lesson', l.instrument + ', ' + when], ['Owner', (l.ownerName || l.firstName) + ' (' + (l.ownerEmail || 'no email on file') + ')'],
          ['Wants to join', name + ' (' + email + (phone ? ', ' + phone : '') + ')'], ['Level', level], ['Music', genres], ['Goals', goals]]) +
        (ownerOk ? '<p>An email asking ' + gh.esc(l.firstName) + ' for a yes or no has been sent.</p>' : '<p><strong>No email could be sent to the lesson owner. Please contact them yourself.</strong></p>'))
    );

    await gh.sendMail(
      email,
      'We have your group class request',
      gh.wrapEmail(
        '<p>Hi ' + gh.esc(gh.firstNameOf(name)) + ',</p>' +
        '<p>Thanks for asking to join a ' + gh.esc(l.instrument.toLowerCase()) + ' group class on ' + gh.esc(when) + '.</p>' +
        '<p>We have asked the student who currently has that time if they are happy to share it. You will get an email as soon as they reply. You are not charged anything yet.</p>' +
        '<p><strong>Good to know:</strong> ' + gh.esc(rule) + '</p>')
    );

    return reply(200, { success: true });
  } catch (e) {
    console.error('[request-group-join] error:', e && e.message ? e.message : e);
    return reply(500, { success: false, error: 'Something went wrong. Nothing was sent. Please try again or contact James.' });
  }
};
