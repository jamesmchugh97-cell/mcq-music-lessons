// group-billing.js
// The money side of group classes, kept apart from the regular enrolment code so the two cannot
// trip each other up.
//
//   - When the joining student pays for the first time, the group is "formed": the student who
//     already had the lesson (if enrolled online) moves to the group price from their next payment.
//   - If the joiner stops, the owner goes back to the private price they were on.
//   - If the owner stops while the joiner stays, the joiner goes back to the private price (it is
//     a private lesson again).
// Every price change is made with no extra charge or refund for the current period, and James is
// emailed about each one. If a price change fails, James is told so he can fix it by hand.
const gh = require('./group-helpers');
const { PRICE_IDS } = require('./subscription-helpers');

async function privatePriceIdFor(durationMinutes, frequency) {
  return PRICE_IDS[String(durationMinutes) + '_' + (frequency === 'fortnightly' ? 'fortnightly' : 'weekly')] || null;
}

// Put a subscription on a one-off group price, keeping its billing rhythm.
async function moveToGroupPrice(stripe, subscriptionId, cents) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const item = sub.items.data[0];
  const price = item.price;
  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price_data: { currency: price.currency, product: typeof price.product === 'string' ? price.product : price.product.id, unit_amount: cents, recurring: { interval: price.recurring.interval, interval_count: price.recurring.interval_count } } }],
    proration_behavior: 'none'
  });
}
// Put a subscription back on its normal private price.
async function moveToPrivatePrice(stripe, subscriptionId, durationMinutes, frequency) {
  const priceId = await privatePriceIdFor(durationMinutes, frequency);
  if (!priceId) throw new Error('no private price for ' + durationMinutes + ' ' + frequency);
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  await stripe.subscriptions.update(subscriptionId, { items: [{ id: sub.items.data[0].id, price: priceId }], proration_behavior: 'none' });
}

async function tellJamesProblem(what, detail) {
  await gh.sendMail(gh.JAMES_EMAIL, 'ACTION NEEDED: group class price change did not go through',
    gh.wrapEmail('<p><strong>' + gh.esc(what) + '</strong></p><p>' + gh.esc(detail) + '</p><p>Please fix this price in Stripe by hand.</p>'));
}

async function findRequest(predicate) {
  const all = await gh.listAllRequests();
  return all.find(predicate) || null;
}
async function save(r) { await gh.requestsStore().set('req_' + r.id, JSON.stringify(r)); }

// The joining student's first payment went through.
async function onJoinerPaid(stripe, subscription) {
  const meta = subscription.metadata || {};
  const r = await findRequest(x => x.id === meta.requestId);
  if (!r) { console.error('[group-billing] no request for', meta.requestId); return; }
  if (r.status === 'active') return; // a later payment of the same group: nothing to change
  const l = r.lesson;
  const when = l.dayName + 's at ' + l.time + ' (' + l.durationMinutes + ' min, ' + l.frequency + ')';
  r.status = 'active'; r.joinerSubscriptionId = subscription.id; r.activatedAt = new Date().toISOString();
  await save(r);
  const g = gh.groupCents(l.durationMinutes), p = gh.privateCents(l.durationMinutes);
  let ownerNote = '';
  if (l.ownerSubscriptionId) {
    try {
      await moveToGroupPrice(stripe, l.ownerSubscriptionId, g);
      r.ownerRepriced = true; await save(r);
      ownerNote = 'Your lesson is now at the group price of ' + gh.dollars(g) + ' per lesson, from your next payment.';
      if (l.ownerEmail) await gh.sendMail(l.ownerEmail, 'Your group class is on',
        gh.wrapEmail('<p>Hi ' + gh.esc(l.firstName) + ',</p><p>' + gh.esc(gh.firstNameOf(r.requester.name)) + ' has joined your ' + gh.esc(when) + ' lesson.</p><p>' + gh.esc(ownerNote) + '</p>' +
          '<p>' + gh.esc(gh.groupRuleText(l.durationMinutes)) + ' If that happens, we will email you first.</p>'));
    } catch (e) {
      console.error('[group-billing] could not move owner to group price:', e && e.message ? e.message : e);
      await tellJamesProblem('Could not lower ' + (l.ownerName || l.firstName) + '\'s price to ' + gh.dollars(g) + ' after ' + r.requester.name + ' joined.', 'Their subscription is ' + l.ownerSubscriptionId + '. ' + (e && e.message ? e.message : ''));
    }
  }
  await gh.sendMail(r.requester.email, 'You are in: your group class is booked',
    gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(r.requester.name)) + ',</p><p>You are booked into the ' + gh.esc(l.instrument.toLowerCase()) + ' group class on ' + gh.esc(when) + '. You pay ' + gh.esc(gh.dollars(g)) + ' per lesson.</p>' +
      '<p><strong>Please remember:</strong> ' + gh.esc(gh.groupRuleText(l.durationMinutes)) + ' We will email you first if that happens.</p><p>If you need to stop, just reply to this email.</p>'));
  await gh.sendMail(gh.JAMES_EMAIL, 'Group class formed: ' + r.requester.name + ' joined ' + (l.ownerName || l.firstName),
    gh.wrapEmail('<p>' + gh.esc(r.requester.name) + ' has paid and joined.</p>' + gh.detailRows([['Lesson', l.instrument + ', ' + when], ['Each pays', gh.dollars(g) + ' (private price ' + gh.dollars(p) + ')'],
      ['Owner price', l.ownerIsRoster ? 'Regular student not enrolled online: sort their price with them in person.' : (r.ownerRepriced ? 'Lowered automatically.' : 'COULD NOT be lowered: see the other email.')]]) +
      '<p>The lesson is already on your calendar under the original student, so nothing else to add.</p>'));
}

// A subscription ended. Is it part of a group?
async function onSubscriptionDeleted(stripe, subscription) {
  const meta = subscription.metadata || {};
  // The joiner left: the owner is back to a private lesson.
  if (meta.groupJoin === 'yes') {
    const r = await findRequest(x => x.joinerSubscriptionId === subscription.id && x.status === 'active');
    if (!r) return;
    const l = r.lesson;
    r.status = 'ended'; r.endedAt = new Date().toISOString(); await save(r);
    let note = '';
    if (l.ownerSubscriptionId && r.ownerRepriced) {
      try {
        await moveToPrivatePrice(stripe, l.ownerSubscriptionId, l.durationMinutes, l.frequency);
        note = 'Your lesson is a private lesson again, so it goes back to ' + gh.dollars(gh.privateCents(l.durationMinutes)) + ' per lesson from your next payment.';
        if (l.ownerEmail) await gh.sendMail(l.ownerEmail, 'Your lesson is private again',
          gh.wrapEmail('<p>Hi ' + gh.esc(l.firstName) + ',</p><p>The other student has stopped coming to your ' + gh.esc(l.dayName + 's at ' + l.time) + ' lesson, so it is a private lesson again.</p><p>' + gh.esc(note) + '</p>'));
      } catch (e) {
        console.error('[group-billing] could not return owner to private price:', e && e.message ? e.message : e);
        await tellJamesProblem('Could not put ' + (l.ownerName || l.firstName) + ' back on the private price after ' + r.requester.name + ' left the group.', 'Their subscription is ' + l.ownerSubscriptionId + '. ' + (e && e.message ? e.message : ''));
      }
    }
    await gh.sendMail(gh.JAMES_EMAIL, 'Group class ended: ' + r.requester.name + ' left ' + (l.ownerName || l.firstName) + '\'s lesson',
      gh.wrapEmail('<p>' + gh.esc(r.requester.name) + ' stopped. ' + (l.ownerIsRoster ? gh.esc(l.ownerName) + ' is a regular student not enrolled online, so adjust their price in person.' : gh.esc(note || 'Owner price was not changed.')) + '</p>'));
    return;
  }
  // The owner left while someone is still in the group: that student is now alone.
  const r = await findRequest(x => x.status === 'active' && x.lesson && x.lesson.ownerSubscriptionId === subscription.id);
  if (!r) return;
  const l = r.lesson;
  r.status = 'owner_left'; r.endedAt = new Date().toISOString(); await save(r);
  try {
    await moveToPrivatePrice(stripe, r.joinerSubscriptionId, l.durationMinutes, l.frequency);
    await gh.sendMail(r.requester.email, 'Your group class is now a private lesson',
      gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(r.requester.name)) + ',</p><p>The other student in your ' + gh.esc(l.dayName + 's at ' + l.time) + ' group class has stopped, so it is now a private lesson.</p>' +
        '<p>As we explained when you joined, it goes back to the private price of ' + gh.esc(gh.dollars(gh.privateCents(l.durationMinutes))) + ' per lesson from your next payment.</p><p>If you would rather not continue, reply to this email and James will cancel it, no problem.</p>'));
  } catch (e) {
    console.error('[group-billing] could not return joiner to private price:', e && e.message ? e.message : e);
    await tellJamesProblem('Could not put ' + r.requester.name + ' back on the private price after the other student left.', 'Their subscription is ' + r.joinerSubscriptionId + '. ' + (e && e.message ? e.message : ''));
  }
  await gh.sendMail(gh.JAMES_EMAIL, 'Group class: the other student left ' + r.requester.name,
    gh.wrapEmail('<p>' + gh.esc(l.ownerName || l.firstName) + ' stopped, so ' + gh.esc(r.requester.name) + ' is now alone in the lesson and was moved to the private price (' + gh.esc(gh.dollars(gh.privateCents(l.durationMinutes))) + '). They were emailed and told they can cancel by replying.</p>'));
}

module.exports = { onJoinerPaid, onSubscriptionDeleted, moveToGroupPrice, moveToPrivatePrice };
