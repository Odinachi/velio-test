# Velio Group Bookings: Plans

Written before any code. Where the build later diverged, it is noted in [Plan vs. reality](#plan-vs-reality) at the bottom.

---

## 1a. Challenging the scope

Five things I'd raise with the product owner before building, each with the assumption I made so I could keep moving.

**1. "25% of opened invites end in a claimed spot": what counts as an "open"?**
One person tapping a link three times, or a link preview bot in WhatsApp unfurling it, would count as several opens and push the rate down. A public link posted in a group chat with 200 people is also a very different kind of "open" from a vouch sent to one friend. Blending them into one 25% target hides the thing the scope itself says matters (vouch vs. share).
*Assumption:* an open is a unique **(invite, device)** pair, tracked server-side when the invite is resolved. Conversion is reported **per rail**, and the 25% target is held against vouch invites. Public links get a separate, lower target that I'd want product to set after a week of baseline data.

**2. "Zero oversold bookings" and "99.5% of attempts on available spots succeed" pull against each other, and the second one needs a precise definition.**
The cheapest way to never oversell is to fail requests whenever there's contention. That's why the second target exists, and I agree with it. But "on available spots" has to be defined: if 50 people race for 1 spot, 49 of them were not attempting an available spot. If those were counted as failures we'd miss the target precisely when the product is most successful.
*Assumption:* the success SLO denominator is attempts that ended as either `success` or `error` (5xx/timeouts). `sold_out` and `already_booked` are correct outcomes, not failures, and are reported separately.

**3. Does a guest who claims through an invite count as a "booker" for the 30% inviter target? And can guests invite?**
If they count, every claimed invite increases the denominator of the inviter rate, and a viral loop would look like it's *lowering* the share of bookers who invite. If guests can't invite, the generation chain stops at 1 and the K-factor is capped.
*Assumption:* guests become full bookers once they claim (they can invite: that's how generation 2+ exists). The 30% metric is reported both for all bookers and for direct bookers only, so the team can see whether the loop is recursive.

**4. "Plans that actually happen" is in the core metric but nothing in the scope measures it.**
We only know a booking happened, not that people showed up. Without check-in this metric is a guess.
*Assumption:* for this prototype, a plan "happened" if the activity's start time has passed and it still had ≥2 confirmed attendees. I'd push for a lightweight host check-in ("who showed up?") as the next feature, because it's the only honest data source.

**5. What happens to an invite when the activity is full, or when the inviter cancels?**
The scope assumes there is always a spot to claim. In practice the most viral activities are the ones that sell out, so the most-shared invites are the ones most likely to dead-end. That's a direct hit on the 25% target. It also hits trust: a friend vouched for you and you got "Sold out".
*Assumption:* an invite for a full activity still opens and shows the activity with a kind "This one's full" state and a way to see other activities by the same host. A waitlist is the obvious next step; I've kept the data model ready for it (cancellations free spots and publish availability) but not built it. Invites stay valid if the inviter cancels: the vouch was for the person, not for the inviter's seat.

---

## 1b. Technical implementation plan

### Architecture

```
 web (Next.js)      mobile (Flutter)
      │  REST + SSE        │
      └────────┬───────────┘
          backend (Fastify, Node + TS)  ──── /metrics (Prometheus), /admin/report
           │                 │
     PostgreSQL         Redis pub/sub
   (source of truth)  (fan-out of availability changes)
```

* **One source of truth:** PostgreSQL holds every booking and every spot count. Redis is only used for fan-out. If Redis is lost, no booking data is lost; clients refetch on reconnect.
* **Stateless API instances.** Any instance can serve bookings; each instance subscribes to Redis and pushes to the SSE clients connected to it. Horizontal scaling needs no sticky sessions.
* **Identity:** a simple user record created with a name; the client sends `x-user-id`. Full auth is out of scope.

### Data model

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id, name, generation, created_at` | `generation` stamped at signup: 0 for organic users, `inviter.generation + 1` for invited users. Trigger forbids changing it. |
| `activities` | `id, host_id, title, starts_at, price_cents, capacity, spots_taken, version, experiment_bucket` | `CHECK (spots_taken BETWEEN 0 AND capacity)`. `version` increments on every availability change. |
| `plans` | `id, activity_id` | The group of people going to an activity. One plan per activity. |
| `bookings` | `id, activity_id, plan_id, user_id, status, invite_id, idempotency_key` | Unique `(activity_id, user_id) WHERE status = 'confirmed'`. Unique `idempotency_key`. |
| `invites` | `id, code, activity_id, inviter_id, rail, contact_label, max_uses, uses, expires_at` | `rail ∈ {vouch, public}`. Vouch: single-use, names a contact. Public: unlimited, no contact. |
| `attributions` | `invitee_id, inviter_id, invite_id, rail, code, generation, is_new_user, booking_id` | **Append-only.** Who invited whom, through which rail and code, at which generation. |
| `events` | `name, user_id, device_id, activity_id, invite_id, rail, props, created_at` | Append-only product event log. Funnel and SLO queries run on it. |

### Concurrency strategy for the last spot

A booking is one transaction whose first statement is a **conditional atomic increment**:

```sql
UPDATE activities
   SET spots_taken = spots_taken + 1, version = version + 1
 WHERE id = $1 AND spots_taken < capacity
RETURNING spots_taken, capacity, version;
```

* Postgres takes a row lock for the `UPDATE`. Concurrent transactions queue on that row and re-evaluate the `WHERE` against the committed value, so exactly `capacity` of them can ever match.
* Zero rows returned → `409 SOLD_OUT`. One row → insert the booking in the same transaction and commit.
* If the booking insert fails (duplicate booking), the whole transaction rolls back, including the increment.
* **Belt and braces:** the `CHECK (spots_taken <= capacity)` constraint means that even a future bug in application code cannot oversell; the database will reject it.
* **Idempotency key** per booking attempt: a client retry after a dropped response returns the original booking instead of taking a second spot.

**Why this over the alternatives**

| Option | Why not |
|---|---|
| `SELECT … FOR UPDATE`, then check, then `UPDATE` | Correct, but holds the lock across two round trips. The single conditional `UPDATE` is the same lock held for less time. |
| Optimistic locking (`WHERE version = $v`) | Correct, but under contention for the last spots almost every attempt loses and has to retry, which is the opposite of what we want for the 99.5% target. |
| Redis counter (`DECR`) as the gate | Fast, but now there are two sources of truth that can drift (Redis decremented, Postgres write failed). Reconciliation logic is where oversells come from. Postgres handles thousands of these row updates per second, far beyond what one activity needs. |
| `SERIALIZABLE` isolation | Correct, but turns contention into serialization failures that need retry loops. |

If one activity ever got hot enough for row-lock queueing to matter (tens of thousands of attempts per second), I'd put a Redis token bucket *in front* as an admission filter, still with Postgres as the authority.

### Real-time availability

1. The booking transaction commits.
2. The API publishes `{activityId, spotsTaken, capacity, version, committedAt}` to the Redis channel `availability`.
3. Every API instance is subscribed and writes the message to every SSE stream watching that activity.
4. Clients apply the update **only if `version` is newer** than what they hold, so out-of-order or duplicate messages can never show a wrong count.
5. On reconnect (SSE retries automatically), clients refetch the activity, so missed messages heal themselves.

**Why SSE rather than WebSockets:** availability is one-way (server → client). SSE is plain HTTP, reconnects automatically, works through proxies, and needs no extra library in the browser. Bookings still go through normal REST calls, which keeps the write path simple and testable.

**Measuring the 2s target:** each message carries `committedAt`. The server also sends its clock in the first SSE frame so clients can estimate clock offset. Clients report `receivedAt − committedAt` (offset-corrected) in batches, and a load test running on one machine (one clock) measures it exactly.

### Immutable, auditable attribution

* `attributions` and `events` have triggers that **reject every `UPDATE`, `DELETE` and `TRUNCATE`**. This is enforced by the database, not by trusting application code. In production I'd also run the app as a DB role with only `INSERT, SELECT` on those tables.
* Attribution is written **in the same transaction** as the claim that caused it. Either both exist or neither does.
* `users.generation` is stamped at signup and a trigger forbids changing it.
* Corrections, if ever needed, are new rows (e.g. a future `attribution_corrections` table), never edits. History is reconstructable at any point in time.

### Rollout: feature flag and holdout

* `INVITES_ENABLED` turns the whole invite feature on or off (kill switch).
* `INVITES_HOLDOUT_PCT` (default 10): each activity is stamped at creation with a stable `experiment_bucket` (0–99, hash of its id). Activities in the holdout don't offer invites; the API refuses invite creation (`403 INVITES_DISABLED`) and the UI hides the button.
* Rollout: internal → 10% → 50% → 90% treatment / 10% holdout, watching SLOs and the oversold check at each step.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Oversell under a race | Conditional update + `CHECK` constraint + a concurrency test that hits the last spot from many connections at once. An `oversold_activities` gauge runs on every scrape. |
| Redis outage | Bookings don't depend on Redis. Publishing failures are logged and counted; clients fall back to refetch on reconnect. |
| Invite code guessing / spam | Codes are 8 characters from a 31-character alphabet (~850 billion combinations); vouch codes are single-use. Rate limiting is next. |
| Link-preview bots inflating opens | Opens are de-duplicated per device; bot user-agents would be filtered before production. |
| Event table growth | Append-only events partition well by month; the views only scan recent windows. |
| Many SSE connections per instance | SSE is cheap (one idle HTTP connection). Beyond a few thousand per instance, scale horizontally; Redis fan-out already supports that. |

---

## 1c. Product implementation plan

### Flows

**Host (web)**
1. Switches to Host and picks or creates their profile.
2. Creates an activity: title, description, location, date and time, price, number of spots.
3. Sees their activities with a live "12 / 20 booked" bar that moves as people book.
4. Opens an activity to see the attendee list update live, with who came through an invite.
5. Can create invites for their own activity (hosts are the first inviters).

**Booker (web)**
1. Browses activities with live spots-left.
2. Opens one: details, price (shown, not charged), who's going.
3. Taps **Book a spot**. The UI updates optimistically ("You're in!") and confirms or rolls back when the server answers.
4. Straight after booking, an **invite prompt** appears (this is the moment the scope expects inviting to happen):
   * **Vouch for a friend**: enter their name → a single-use code just for them. Copy says plainly that this is a vouch.
   * **Share a public link**: one link for a group chat; reach, not trust.
5. Sees invites they've created and whether each was claimed.

**Invited guest (Flutter, also a web fallback)**
1. Opens the link (`velio://invite/CODE` or the web URL) or types the code.
2. Sees *who* invited them ("Ada vouched for you") and the activity, with live spots-left.
3. Enters their first name (that's the whole signup) and taps **Claim my spot**.
4. Success haptic, a "You're in" screen, and the plan with who else is going.

### Edge cases

| Situation | What the user sees |
|---|---|
| Spot sells out mid-checkout | The optimistic "You're in" rolls back to a gentle message: "Someone grabbed the last spot a moment before you." The page already shows "Sold out" because live updates arrived. No error codes. |
| Invite for a full activity | Invite still opens and shows the activity and who invited them. The claim button is replaced by "This one filled up" and the inviter's other plans. |
| Expired code | "This invite has expired." Shows the activity if it's still upcoming so the guest can book directly. |
| Vouch code already used | "This invite was already claimed." If it was claimed by this same user, it shows their booking instead (idempotent). |
| Guest already booked | "You're already going," not an error. |
| Guest offline | The app shows cached activity details with an "Offline, showing saved details" banner. Claim is disabled with a clear reason, and retries automatically when connectivity returns. The idempotency key makes a retry safe. |
| Live connection drops | SSE reconnects; the app refetches on reconnect so counts are never stale for long. |
| Double-tap on Book | Same idempotency key → one booking. |

### What I'll build in 48 hours

* Backend: activities, bookings with the concurrency strategy, cancellation, invites on both rails, claim with attribution, SSE, feature flag and holdout, event log, `/metrics`, `/admin/report`.
* Concurrency test, attribution immutability test, and a load test that measures the SLOs.
* Web: host dashboard with live attendance, booker view with optimistic booking and invite creation, an admin page showing SLOs and product goals, a web fallback for invite links.
* Flutter: enter or open code → view activity (live) → claim, with haptics, offline cache and clear states.

### What I'd ship next

1. Waitlist that auto-fills cancelled spots (the most-shared activities are the ones that sell out).
2. Host check-in so "plans that actually happen" is measured, not inferred.
3. Real auth and contact picker for vouches, and push notifications.
4. Rate limiting and bot filtering on invite opens.

---

## 1d. Tracking plan

### Events

| Event | Source | Properties |
|---|---|---|
| `user_signed_up` | server | `generation`, `invite_id`, `rail` |
| `activity_viewed` | client → `/events` | `activity_id`, `device_id` |
| `booking_attempted` | server | `activity_id` |
| `booking_succeeded` | server | `activity_id`, `via_invite`, `duration_ms` |
| `booking_sold_out` | server | `activity_id` |
| `booking_failed` | server | `activity_id`, `error` |
| `invite_created` | server | `rail`, `activity_id`, `invite_id` |
| `invite_opened` | server (on resolve) | `invite_id`, `rail`, `device_id` |
| `spot_claimed` | server | `invite_id`, `rail`, `is_new_user`, `generation` |
| `availability_received` | client → `/events` | `latency_ms`, `activity_id` |

Technical counters and histograms are also exposed in Prometheus format at `/metrics`.

### Goals → metrics

| Goal | Metric and how it's measured | Target | Trigger for an improvement plan |
|---|---|---|---|
| Never oversell | Activities where `spots_taken > capacity` **or** confirmed bookings ≠ `spots_taken`. Checked on every `/metrics` scrape and in `/admin/report`. | 0, ever | Any non-zero value is a P0 incident, not an improvement plan. |
| Bookings succeed when spots exist | `success / (success + error)` over booking attempts; sold-out and already-booked excluded (see 1a.2). | ≥ 99.5% | Below 99.5% over any 1-hour window, or below 99.9% for a full day. |
| Availability feels live | p95 of `availability_received.latency_ms` (offset-corrected), and exactly in the load test. | p95 ≤ 2s | p95 > 2s over a day, or p99 > 5s. |
| Bookers become inviters | Distinct bookers (in non-holdout activities) who created ≥1 invite ÷ distinct bookers. Shown for all bookers and for direct bookers. | ≥ 30% | Below 30% for 2 consecutive weeks. |
| Invites turn into guests | Unique (invite, device) opens that ended in `spot_claimed` ÷ unique opens. Per rail. | ≥ 25% (vouch) | Below target for 2 consecutive weeks on ≥200 opens. |
| Core: K-factor | New users acquired via invites ÷ bookers in the same period, **split by rail**. Also new users per inviter. | Watch, no target set | A drop of >20% week over week. |
| Core: plans that happen | Share of past activities with ≥2 confirmed attendees at start time. | Watch | Drop vs. holdout. |

### Holdout design

Invites are randomised **at the activity level**: 10% of activities (stable hash of activity id) never offer invites. I chose activities rather than users because a plan is shared: if Ada is in treatment and Ben in holdout on the same activity, Ada's invites would also fill Ben's plan, and a user-level split would leak. Comparing treatment and holdout activities on **fill rate**, **share with ≥2 attendees**, and **new users whose first booking was on that activity** tells us whether invites *cause* more plans. Engaged users are spread evenly across both arms by the randomisation, so a difference can't be explained by "engaged people invite more". Some spillover remains (a user invited to a treatment activity may later book a holdout one), which biases the result *towards zero*, so a measured lift is conservative. At expected volumes, I'd read the result after ~2 weeks or once each arm has ~400 activities, whichever is later.

---

## Plan vs. reality

Filled in after the build.

**Built as planned:** everything listed under "What I'll build in 48 hours": the concurrency strategy, SSE over Redis, both invite rails, claim with attribution, append-only history, activity-level holdout, event log, `/metrics`, `/admin/report`, the web app (booker, host, invite landing, tracking page) and the Flutter guest app. The load test confirms the technical SLOs (results in the README).

**Added**

* **Cancellation.** Not in the scope, but it's the only way a full activity can become available again, so it's needed to test "sold out → spot appears live" and it's the foundation for a waitlist.
* **Server-side fan-out latency** (`velio_availability_fanout_seconds`). The client-reported latency depends on a clock-offset estimate that ignores one-way network delay, so it slightly under-reads. The server metric and the single-clock load test cover that gap.
* **A web landing page for invite links** (`/i/CODE`), so a link opened on a laptop works end to end, not only in the app.

**Changed or learned**

* **Losing transactions must end immediately.** While testing, I found that in Postgres a waiter that loses the race for the last spot still holds the row lock until its transaction ends. Holding losers open makes everyone behind them queue. The API rolls back as soon as it sees `SOLD_OUT`; the concurrency test documents this.
* **"Bookings don't depend on Redis" needed proving.** An outage test showed the Redis client queueing publishes while disconnected, so a committed booking waited 30s+ for its broadcast and the client saw a timeout despite holding the spot. Publishing now fails fast (500ms cap, no offline queue) and isn't awaited in the request path.
* **`rejected` is its own booking outcome.** Besides success, sold out and errors there are correct refusals (host booking their own activity, activity already started). They are excluded from the success-rate SLO the same way sold out is (see 1a.2).

**Not built (deliberately)**

* Rate limiting and bot filtering of invite opens (risk table above; also item 1 in `OWNERSHIP.md`).
* Auth on `/admin/report` and `/metrics`.
* Inviting from the Flutter app. The brief scopes the app to the guest journey; guests who want to bring someone else use the web app, which is how generation 2+ happens. The tests cover multi-hop generations.
