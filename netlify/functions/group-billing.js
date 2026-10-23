// group-billing.js
// The money side of group classes, kept apart from the regular enrolment code so the two cannot
// trip each other up.
//
//   - When the joining student pays for the first time, the group is "formed": the student who
//     already had the lesson (if enrolled online) moves to the group price from their next payment.
//   - Prices follow the class size: group price for two, $5 less each for three, private for one.
//     Whenever someone joins or leaves, every remaining student is moved to the right price from
//     their next payment (see applyPricing).
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

function whenOf(l) { return l.dayName + 's at ' + l.time + ' (' + l.durationMinutes + ' min, ' + l.frequency + ')'; }

// Who is in this class right now: the lesson's owner (unless they have left) and every paid-up student.
async function membersOf(r) {
  const all = await gh.listAllRequests();
  const joiners = all.filter(x => x.listingId === r.listingId && x.status === 'active');
  const ownerGone = joiners.some(x => x.ownerLeft) || !!r.ownerLeft;
  const l = r.lesson;
  const members = [];
  if (!ownerGone) members.push({ role: 'owner', name: l.ownerName || l.firstName, email: l.ownerIsRoster ? null : l.ownerEmail, subscriptionId: l.ownerIsRoster ? null : l.ownerSubscriptionId, roster: !!l.ownerIsRoster });
  joiners.forEach(x => members.push({ role: 'joiner', name: x.requester.name, email: x.requester.email, subscriptionId: x.joinerSubscriptionId, request: x }));
  return { members: members, ownerGone: ownerGone, joiners: joiners, all: all };
}

// Make every student's price match the class size: group price for two, $5 less each for three, the
// normal private price for one. Skips anyone who has just paid at the right price. Emails each student
// whose price changed (from their next payment) and tells James about any change that fails.
async function applyPricing(stripe, r, skipSubscriptionId, reason) {
  const l = r.lesson;
  const { members } = await membersOf(r);
  const size = members.length;
  const target = gh.priceForSize(l.durationMinutes, size);
  const when = whenOf(l);
  const notes = [];
  for (const m of members) {
    if (!m.subscriptionId || m.subscriptionId === skipSubscriptionId) continue;
    try {
      if (size >= 2) await moveToGroupPrice(stripe, m.subscriptionId, target);
      else await moveToPrivatePrice(stripe, m.subscriptionId, l.durationMinutes, l.frequency);
      if (m.request) { m.request.lastPriceCents = target; await save(m.request); }
      if (m.email) await gh.sendMail(m.email, size >= 2 ? 'Your group class price has changed' : 'Your lesson is private again',
        gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(m.name)) + ',</p><p>' + gh.esc(reason) + '</p><p>Your ' + gh.esc(when) + ' lesson is now <strong>' + gh.esc(gh.dollars(target)) + ' per lesson</strong>' + (size >= 2 ? ' (' + size + ' students)' : ' (private)') + ', from your next payment.</p><p>' + gh.esc(gh.groupRuleText(l.durationMinutes)) + '</p>'));
      notes.push(gh.firstNameOf(m.name) + ' now ' + gh.dollars(target));
    } catch (e) {
      console.error('[group-billing] price change failed:', e && e.message ? e.message : e);
      await tellJamesProblem('Could not change ' + m.name + '\'s price to ' + gh.dollars(target) + '.', 'Their subscription is ' + m.subscriptionId + '. ' + (e && e.message ? e.message : ''));
    }
  }
  return { size: size, target: target, notes: notes, members: members };
}

// The joining student's first payment went through.
async function onJoinerPaid(stripe, subscription) {
  const meta = subscription.metadata || {};
  const r = await findRequest(x => x.id === meta.requestId);
  if (!r) { console.error('[group-billing] no request for', meta.requestId); return; }
  if (r.status === 'active') return; // a later payment of the same group: nothing to change
  const l = r.lesson;
  const when = whenOf(l);
  r.status = 'active'; r.joinerSubscriptionId = subscription.id; r.activatedAt = new Date().toISOString();
  const existing = await membersOf(r);
  if (existing.ownerGone) r.ownerLeft = true;
  await save(r);
  const res = await applyPricing(stripe, r, subscription.id, gh.firstNameOf(r.requester.name) + ' has joined your ' + when + ' class.');
  // The owner, if enrolled online, is now on a group price: remember so a later change can put them back.
  if (l.ownerSubscriptionId && !l.ownerIsRoster && !existing.ownerGone) { r.ownerRepriced = true; await save(r); }
  const joinerPrice = gh.priceForSize(l.durationMinutes, res.size), p = gh.privateCents(l.durationMinutes);
  await gh.sendMail(r.requester.email, 'You are in: your group class is booked',
    gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(r.requester.name)) + ',</p><p>You are booked into the ' + gh.esc(l.instrument.toLowerCase()) + ' group class on ' + gh.esc(when) + '. You pay ' + gh.esc(gh.dollars(joinerPrice)) + ' per lesson.</p>' +
      '<p><strong>Please remember:</strong> ' + gh.esc(gh.groupRuleText(l.durationMinutes)) + '</p><p>If you need to stop, just reply to this email.</p>'));
  await gh.sendMail(gh.JAMES_EMAIL, 'Group class formed: ' + r.requester.name + ' joined ' + (l.ownerName || l.firstName),
    gh.wrapEmail('<p>' + gh.esc(r.requester.name) + ' has paid and joined. There are now ' + res.size + ' students in this class.</p>' + gh.detailRows([['Lesson', l.instrument + ', ' + when], ['Each pays', gh.dollars(joinerPrice) + ' (private price ' + gh.dollars(p) + ')'],
      ['Prices changed', res.notes.length ? res.notes.join(', ') : 'None needed.'], ['Owner', l.ownerIsRoster ? 'Regular student not enrolled online: sort their price with them in person.' : 'Handled automatically.']]) +
      '<p>The lesson is already on your calendar under the original student, so nothing else to add.</p>'));
}

// A subscription ended. Is it part of a group?
async function onSubscriptionDeleted(stripe, subscription) {
  const meta = subscription.metadata || {};
  if (meta.groupJoin === 'yes') {
    // A joiner left.
    const r = await findRequest(x => x.joinerSubscriptionId === subscription.id && x.status === 'active');
    if (!r) return;
    const l = r.lesson;
    r.status = 'ended'; r.endedAt = new Date().toISOString(); await save(r);
    const res = await applyPricing(stripe, r, null, gh.firstNameOf(r.requester.name) + ' has stopped coming to your ' + whenOf(l) + ' class.');
    await gh.sendMail(gh.JAMES_EMAIL, 'Group class: ' + r.requester.name + ' left ' + (l.ownerName || l.firstName) + '\'s lesson',
      gh.wrapEmail('<p>' + gh.esc(r.requester.name) + ' stopped. ' + res.size + ' student' + (res.size === 1 ? ' is' : 's are') + ' left. ' + gh.esc(res.notes.length ? 'Prices changed: ' + res.notes.join(', ') + '.' : 'No price was changed.') + (l.ownerIsRoster ? ' ' + gh.esc(l.ownerName) + ' is a regular student not enrolled online, so adjust their price in person.' : '') + '</p>'));
    return;
  }
  // The owner left while others are still in the group.
  const mine = (await gh.listAllRequests()).filter(x => x.status === 'active' && x.lesson && x.lesson.ownerSubscriptionId === subscription.id && !x.ownerLeft);
  if (!mine.length) return;
  const l = mine[0].lesson;
  for (const x of mine) { x.ownerLeft = true; await save(x); }
  const res = await applyPricing(stripe, mine[0], null, (l.ownerName || l.firstName) + ' has stopped coming to your ' + whenOf(l) + ' class.');
  await gh.sendMail(gh.JAMES_EMAIL, 'Group class: ' + (l.ownerName || l.firstName) + ' left, ' + res.size + ' student' + (res.size === 1 ? '' : 's') + ' remain',
    gh.wrapEmail('<p>' + gh.esc(l.ownerName || l.firstName) + ' stopped. ' + gh.esc(res.notes.length ? 'Prices changed: ' + res.notes.join(', ') + '.' : 'No price was changed.') + ' Their calendar slot may need updating.</p>'));
}

// ---- Studio closures -------------------------------------------------------------------------
// Students who joined a group class are billed on their own and are not in the enrolment list that the
// closure tools go through, so they are handled here: told when a closure is set, paused when it
// starts and resumed if it is cleared early.
async function activeJoiners() {
  return (await gh.listAllRequests()).filter(x => x.status === 'active' && x.joinerSubscriptionId);
}
async function notifyJoinersOfClosure(startFriendly, endFriendly) {
  let n = 0;
  for (const x of await activeJoiners()) {
    if (!x.requester.email) continue;
    await gh.sendMail(x.requester.email, 'MCQ Music Lessons: closed ' + startFriendly + ' to ' + endFriendly,
      gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(x.requester.name)) + ',</p><p>Just a heads up, MCQ Music will be closed from ' + gh.esc(startFriendly) + ' to ' + gh.esc(endFriendly) + '. Your group class payments are paused for that time and start again afterwards. You do not need to do anything.</p>'));
    n++;
  }
  return n;
}
async function pauseJoinersForClosure(stripe, endDateStr) {
  const resumeEpoch = Math.floor(new Date(endDateStr + 'T00:00:00').getTime() / 1000);
  let n = 0;
  for (const x of await activeJoiners()) {
    try {
      await stripe.subscriptions.update(x.joinerSubscriptionId, { pause_collection: { behavior: 'void', resumes_at: resumeEpoch } });
      x.pausedForClosure = true; await save(x); n++;
    } catch (e) {
      console.error('[group-billing] could not pause joiner for closure:', e && e.message ? e.message : e);
      await tellJamesProblem('Could not pause ' + x.requester.name + '\'s group class payments for the closure.', 'Their subscription is ' + x.joinerSubscriptionId + '. ' + (e && e.message ? e.message : ''));
    }
  }
  return n;
}
async function resumeJoinersAfterClosure(stripe) {
  let n = 0;
  for (const x of await activeJoiners()) {
    if (!x.pausedForClosure) continue;
    try {
      await stripe.subscriptions.update(x.joinerSubscriptionId, { pause_collection: '' });
      x.pausedForClosure = false; await save(x); n++;
    } catch (e) {
      console.error('[group-billing] could not resume joiner:', e && e.message ? e.message : e);
      await tellJamesProblem('Could not resume ' + x.requester.name + '\'s group class payments after the closure was cleared.', 'Their subscription is ' + x.joinerSubscriptionId + '. ' + (e && e.message ? e.message : ''));
    }
  }
  return n;
}

// ---- Failed payments --------------------------------------------------------------------------
// A group student's payment failed. Tell the student and James (once per run of failures).
async function onJoinerPaymentFailed(subscription) {
  const r = await findRequest(x => x.joinerSubscriptionId === subscription.id && x.status === 'active');
  if (!r || r.paymentFailedAt) return;
  r.paymentFailedAt = new Date().toISOString(); await save(r);
  const l = r.lesson;
  await gh.sendMail(r.requester.email, 'MCQ Music Lessons: payment issue with your group class',
    gh.wrapEmail('<p>Hi ' + gh.esc(gh.firstNameOf(r.requester.name)) + ',</p><p>We could not process your latest group class payment. Stripe will try again over the next few days. If it still does not go through, please reply to this email so we can sort it out.</p>'));
  await gh.sendMail(gh.JAMES_EMAIL, 'Payment failed: ' + r.requester.name + ' (group class)',
    gh.wrapEmail('<p>' + gh.esc(r.requester.name) + '\'s group class payment failed (' + gh.esc(l.instrument + ', ' + whenOf(l)) + '). Stripe will retry. If it is not resolved, you may need to cancel their group class in Stripe.</p>'));
}
async function onJoinerPaymentRecovered(subscription) {
  const r = await findRequest(x => x.joinerSubscriptionId === subscription.id && x.status === 'active' && x.paymentFailedAt);
  if (r) { delete r.paymentFailedAt; await save(r); }
}

module.exports = {
  notifyJoinersOfClosure, pauseJoinersForClosure, resumeJoinersAfterClosure, onJoinerPaymentFailed, onJoinerPaymentRecovered, onJoinerPaid, onSubscriptionDeleted, moveToGroupPrice, moveToPrivatePrice, membersOf };
