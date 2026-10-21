// group-billing.js
// The money side of group classes, kept apart from the regular enrolment code so the two cannot
// trip each other up.
//
//   - When the joining student pays for the first time, the group is "formed": the student who
//     already had the lesson (if enrolled online) moves to the group price from their next payment.
//   - A third student can join at the same group price; nobody else's price changes.
//   - When only one student is left (whoever it is), that student goes back to the private price.
//     While two or three remain, the group price stays.
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

// Everyone currently in a class: other paid-up students on the same lesson.
async function othersActive(r) {
  const all = await gh.listAllRequests();
  return all.filter(x => x.listingId === r.listingId && x.status === 'active' && x.id !== r.id);
}
function whenOf(l) { return l.dayName + 's at ' + l.time + ' (' + l.durationMinutes + ' min, ' + l.frequency + ')'; }
// Email the owner (if enrolled online) and every other paid-up student.
async function emailClass(r, others, subject, line, skipEmail) {
  const l = r.lesson;
  const people = [];
  if (l.ownerEmail && !l.ownerIsRoster && !others.some(x => x.ownerLeft) && !r.ownerLeft) people.push({ name: l.firstName, email: l.ownerEmail });
  others.forEach(x => people.push({ name: x.requester.name, email: x.requester.email }));
  for (const p of people) {
    if (!p.email || p.email === skipEmail) continue;
    await gh.sendMail(p.email, subject, gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(p.name)) + ',</p><p>' + gh.esc(line) + '</p>'));
  }
}

// The joining student's first payment went through.
async function onJoinerPaid(stripe, subscription) {
  const meta = subscription.metadata || {};
  const r = await findRequest(x => x.id === meta.requestId);
  if (!r) { console.error('[group-billing] no request for', meta.requestId); return; }
  if (r.status === 'active') return; // a later payment of the same group: nothing to change
  const l = r.lesson;
  const when = whenOf(l);
  const others = await othersActive(r);
  r.status = 'active'; r.joinerSubscriptionId = subscription.id; r.activatedAt = new Date().toISOString();
  await save(r);
  const g = gh.groupCents(l.durationMinutes), p = gh.privateCents(l.durationMinutes);
  const ownerGone = others.some(x => x.ownerLeft);
  if (ownerGone) { r.ownerLeft = true; await save(r); }
  let ownerNote = '';
  if (others.length === 0 && l.ownerSubscriptionId) {
    // The second student: the owner moves to the group price.
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
  } else if (others.length > 0) {
    // A third student: everyone is already on the group price. Just tell the others.
    await emailClass(r, others, 'A new student has joined your group class', gh.firstNameOf(r.requester.name) + ' has joined your ' + when + ' class. Your price stays at the group price of ' + gh.dollars(g) + ' per lesson.', r.requester.email);
  }
  await gh.sendMail(r.requester.email, 'You are in: your group class is booked',
    gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(r.requester.name)) + ',</p><p>You are booked into the ' + gh.esc(l.instrument.toLowerCase()) + ' group class on ' + gh.esc(when) + '. You pay ' + gh.esc(gh.dollars(g)) + ' per lesson.</p>' +
      '<p><strong>Please remember:</strong> ' + gh.esc(gh.groupRuleText(l.durationMinutes)) + ' We will email you first if that happens.</p><p>If you need to stop, just reply to this email.</p>'));
  await gh.sendMail(gh.JAMES_EMAIL, 'Group class formed: ' + r.requester.name + ' joined ' + (l.ownerName || l.firstName),
    gh.wrapEmail('<p>' + gh.esc(r.requester.name) + ' has paid and joined. There are now ' + (others.length + (ownerGone ? 1 : 2)) + ' students in this class.</p>' + gh.detailRows([['Lesson', l.instrument + ', ' + when], ['Each pays', gh.dollars(g) + ' (private price ' + gh.dollars(p) + ')'],
      ['Owner price', others.length > 0 ? 'Already on the group price.' : (l.ownerIsRoster ? 'Regular student not enrolled online: sort their price with them in person.' : (r.ownerRepriced ? 'Lowered automatically.' : 'COULD NOT be lowered: see the other email.'))]]) +
      '<p>The lesson is already on your calendar under the original student, so nothing else to add.</p>'));
}

// A subscription ended. Is it part of a group?
async function onSubscriptionDeleted(stripe, subscription) {
  const meta = subscription.metadata || {};
  // A joiner left.
  if (meta.groupJoin === 'yes') {
    const r = await findRequest(x => x.joinerSubscriptionId === subscription.id && x.status === 'active');
    if (!r) return;
    const l = r.lesson;
    r.status = 'ended'; r.endedAt = new Date().toISOString(); await save(r);
    const others = await othersActive(r);
    const ownerGone = !!r.ownerLeft || others.some(x => x.ownerLeft);
    const remaining = (ownerGone ? 0 : 1) + others.length;
    const g = gh.groupCents(l.durationMinutes);
    if (remaining >= 2) {
      // Still a group of two or more: nobody's price changes.
      await emailClass(r, others, 'A student has left your group class', gh.firstNameOf(r.requester.name) + ' has stopped coming to your ' + l.dayName + 's at ' + l.time + ' class. It is still a group class, so your price stays at ' + gh.dollars(g) + ' per lesson.', null);
      await gh.sendMail(gh.JAMES_EMAIL, 'Group class: ' + r.requester.name + ' left, class continues',
        gh.wrapEmail('<p>' + gh.esc(r.requester.name) + ' stopped. ' + remaining + ' students are still in the class, so prices are unchanged.</p>'));
      return;
    }
    let note = '';
    if (remaining === 1 && ownerGone && others.length === 1) {
      // The last one left is a joiner: private price.
      try {
        await moveToPrivatePrice(stripe, others[0].joinerSubscriptionId, l.durationMinutes, l.frequency);
        await gh.sendMail(others[0].requester.email, 'Your group class is now a private lesson',
          gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(others[0].requester.name)) + ',</p><p>The other students in your ' + gh.esc(l.dayName + 's at ' + l.time) + ' class have stopped, so it is now a private lesson. As we explained when you joined, it goes back to the private price of ' + gh.esc(gh.dollars(gh.privateCents(l.durationMinutes))) + ' per lesson from your next payment.</p><p>If you would rather not continue, reply to this email and James will cancel it, no problem.</p>'));
        note = gh.firstNameOf(others[0].requester.name) + ' is now on the private price.';
      } catch (e) {
        console.error('[group-billing] could not return remaining student to private price:', e && e.message ? e.message : e);
        await tellJamesProblem('Could not put ' + others[0].requester.name + ' back on the private price after the others left.', 'Their subscription is ' + others[0].joinerSubscriptionId + '. ' + (e && e.message ? e.message : ''));
      }
    } else if (remaining === 1 && !ownerGone) {
      // Only the owner is left: back to the private price they were on.
      // Was the owner ever moved to the group price? Look at every request for this lesson, including ones that have ended.
      const everything = (await gh.listAllRequests()).filter(x => x.listingId === r.listingId);
      const repriced = everything.some(x => x.ownerRepriced);
      if (l.ownerSubscriptionId && repriced) {
        try {
          await moveToPrivatePrice(stripe, l.ownerSubscriptionId, l.durationMinutes, l.frequency);
          for (const x of everything) { if (x.ownerRepriced) { x.ownerRepriced = false; await save(x); } }
          note = 'Your lesson is a private lesson again, so it goes back to ' + gh.dollars(gh.privateCents(l.durationMinutes)) + ' per lesson from your next payment.';
          if (l.ownerEmail) await gh.sendMail(l.ownerEmail, 'Your lesson is private again',
            gh.wrapEmail('<p>Hi ' + gh.esc(l.firstName) + ',</p><p>The other students have stopped coming to your ' + gh.esc(l.dayName + 's at ' + l.time) + ' lesson, so it is a private lesson again.</p><p>' + gh.esc(note) + '</p>'));
        } catch (e) {
          console.error('[group-billing] could not return owner to private price:', e && e.message ? e.message : e);
          await tellJamesProblem('Could not put ' + (l.ownerName || l.firstName) + ' back on the private price after ' + r.requester.name + ' left the group.', 'Their subscription is ' + l.ownerSubscriptionId + '. ' + (e && e.message ? e.message : ''));
        }
      }
    }
    await gh.sendMail(gh.JAMES_EMAIL, 'Group class ended: ' + r.requester.name + ' left ' + (l.ownerName || l.firstName) + '\'s lesson',
      gh.wrapEmail('<p>' + gh.esc(r.requester.name) + ' stopped. ' + (l.ownerIsRoster ? gh.esc(l.ownerName) + ' is a regular student not enrolled online, so adjust their price in person.' : gh.esc(note || 'No price was changed.')) + '</p>'));
    return;
  }
  // The owner left while others are still in the group.
  const mine = (await gh.listAllRequests()).filter(x => x.status === 'active' && x.lesson && x.lesson.ownerSubscriptionId === subscription.id && !x.ownerLeft);
  if (!mine.length) return;
  const l = mine[0].lesson;
  for (const x of mine) { x.ownerLeft = true; await save(x); }
  if (mine.length >= 2) {
    // Two or more are still in: still a group, no price change.
    for (const x of mine) await gh.sendMail(x.requester.email, 'A student has left your group class',
      gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(x.requester.name)) + ',</p><p>One of the students in your ' + gh.esc(l.dayName + 's at ' + l.time) + ' class has stopped. It is still a group class, so your price stays at ' + gh.esc(gh.dollars(gh.groupCents(l.durationMinutes))) + ' per lesson.</p>'));
    await gh.sendMail(gh.JAMES_EMAIL, 'Group class: ' + (l.ownerName || l.firstName) + ' left, class continues',
      gh.wrapEmail('<p>' + gh.esc(l.ownerName || l.firstName) + ' stopped, but ' + mine.length + ' students are still in the class, so prices are unchanged. Their calendar slot may need updating.</p>'));
    return;
  }
  const r = mine[0];
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
