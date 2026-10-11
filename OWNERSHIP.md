# Ownership: invites convert at 11%, target 25%

**Situation, day 30.** Booking is healthy (zero oversells, SLOs green), and 34% of bookers invite, so people *want* to bring friends. The loss happens after the friend opens the invite: 11% claim against a 25% target. Most opens are on mobile; vouches convert better than public links.

## 1. Diagnose

What I'd look at first, in this order (most of it is already queryable from `events`):

1. **Invite status at open.** `invite_opened.props.status` records whether the invite was `full`, `used` or `expired` when opened. If a large share of opens hit a full activity, the funnel is broken by design: the best activities sell out, and those are exactly the ones people invite to.
2. **Conversion by rail × surface.** Vouch vs. public, and app vs. mobile web vs. desktop. That tells us whether this is a public-link mix problem or a mobile flow problem.
3. **Time from invite created → opened → claimed.** Long gaps point to a sell-out race or slow message delivery.
4. **Opens per invite.** Public links in big group chats, link-preview bots and the same person opening on two devices all inflate the denominator.

**Top hypotheses**

* **H1: The spot is gone by the time the friend opens it** (most likely). The booker invites right after booking, and the friend opens hours later.
* **H2: Mobile friction.** The open lands on web or asks for the app; one extra step on a phone costs a lot.
* **H3: Mix shift to public links.** Low intent per open drags the average down even if vouches are fine.
* **H4: The measurement inflates opens** (bots, duplicate devices), so the true rate is higher than 11%.

## 2. Improve (ranked by impact ÷ effort)

| # | Change | Type | Impact | Effort |
|---|---|---|---|---|
| 1 | Add `invite_viewed_claim_form`, `claim_started`, `claim_failed{code}` events, a surface tag, and bot user-agent filtering | Tracking | Unblocks everything | S |
| 2 | **Hold a spot for each vouch** for 24h (max 2 per booker). Holds count against capacity in the same conditional update, and expire back to the pool. | Product + tech | High (fixes H1) | M |
| 3 | **Waitlist for full invites**: "Notify me" auto-claims the next cancelled spot | Product + tech | High | M |
| 4 | One-field mobile-web claim (no install), plus universal links to open the app when it's installed | Product + tech | Medium–high (H2) | M |
| 5 | Make vouch the default after booking (contact picker), and show "who's going" on public links | Product | Medium (H3) | S |
| 6 | Nudge the inviter when a vouch is unclaimed after 6h ("Ben hasn't claimed yet, 2 spots left") | Product | Medium | S |

## 3. Prove it

* Ship #1 first and re-baseline for a week. If bots or duplicate devices explain a big part of the gap, the target conversation changes before we build anything.
* Test #2 and #3 as an experiment **inside the invite treatment arm**, randomised **per activity** (holds change availability for everyone on that activity, so a user-level split would leak). Primary metric: claimed ÷ unique opens on vouches. Guardrails: fill rate, share of holds that expire unused, booking success SLO, and oversold must stay 0.
* Sizing: from 11% to 16% at α = 0.05 and 80% power needs about 700 unique opens per arm, so roughly two weeks at current volume.
* Keep the existing 10% **invite holdout** running throughout. It answers the question that matters more than conversion: do invites cause more plans and new users than not having invites at all?

## 4. Decide

If conversion is still under 25% after these changes, I would **keep the feature and change the goal, not remove it.**

* 25% was set before we had data, and it blends two very different rails. Public links will never convert like a personal vouch, and they don't need to: they're for reach. I'd set separate targets (for example 25% vouch, 8–10% public) from the post-fix baseline.
* The decision that matters is the holdout comparison. If treatment activities show more plans with 2+ people and more first-time bookers than holdout activities, the feature is creating value even at 15% conversion, so we keep iterating on it.
* **I would remove the feature only if the holdout shows no lift** in plans or new users after the fixes. In that case 34% of bookers are doing work that brings nobody new, which costs them trust and clutters the product. Even then, I'd first cut the public rail and keep vouches, because they carry the trust signal Velio is built on.
