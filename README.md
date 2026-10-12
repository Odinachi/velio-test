# Velio · Group bookings with live availability and viral invites

A host creates an activity with limited spots. People book, see availability change live, and bring friends through **vouch** invites (personal, single-use, carries trust) or **public** share links (reach only). Invited guests claim their spot from the Flutter app.

| Folder | What |
|---|---|
| [`backend/`](backend) | Node.js + TypeScript (Fastify), PostgreSQL, Redis. REST + Server-Sent Events. |
| [`web/`](web) | Next.js + TypeScript. Booker, host and tracking views, plus a web landing page for invite links. |
| [`mobile/`](mobile) | Flutter guest app: open or enter an invite, watch it live, claim a spot. |
| [`PLANS.md`](PLANS.md) | Scope questions, technical, product and tracking plans (written before the code), and plan vs. reality. |
| [`OWNERSHIP.md`](OWNERSHIP.md) | Improvement plan for the 30-day scenario. |

---

## Running everything

### Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Docker Desktop | any recent | PostgreSQL 16 and Redis 7 |
| Node.js | 20.9+ (tested on 22) | backend and web |
| Flutter | 3.27+ | guest app |
| Xcode (macOS) or Android Studio | latest stable | iOS simulator or Android emulator |

Ports used: **5442** Postgres, **6389** Redis, **4000** API, **3000** web. Postgres and Redis use non-default ports so they don't clash with local installs.

### Quick start

```bash
# Terminal 1: database and cache
docker compose up -d

# Terminal 2: API on http://localhost:4000 (applies migrations on start, reloads on save)
cd backend && npm install && npm run dev

# Terminal 3: demo data (run once the API is up)
cd backend && npm run seed

# Terminal 4: web app on http://localhost:3000
cd web && npm install && npm run dev

# Terminal 5: guest app on a simulator or emulator
cd mobile && flutter pub get && flutter run
```

The seed prints two invite codes, something like:

```
Vouch code for Kemi:  ZV673W5P   http://localhost:3000/i/ZV673W5P
Public share code:    SXTFUZ5H   http://localhost:3000/i/SXTFUZ5H
```

Check it's all up:

```bash
docker compose ps                     # postgres and redis: healthy
curl localhost:4000/health            # {"ok":true}
open http://localhost:3000            # web app
```

### A 5-minute walkthrough

1. **Book on the web.** Open http://localhost:3000, click **Profile** (top right) and create a name. There's no auth; the profile menu also lets you switch between people. Open an activity and book it. *Pottery Night* has one spot left, so it's good for testing the sold-out state.
2. **Watch it live.** Open the same activity in a second browser window (a private window gets its own profile). Book in one and watch the count, bar and guest list change in the other.
3. **Invite.** After booking, the invite panel appears. Create a **vouch** (for a named friend, single-use) or a **share link** (reusable).
4. **Claim on the phone.** In the app, type the vouch code (or paste it with the clipboard button) and claim with a first name. Keep the web activity page open and the new guest appears in the list.
5. **Host view.** Switch to **Host**, create an activity, and open it for live attendance showing who came through which invite.
6. **Tracking.** Open http://localhost:3000/admin for every scope goal, the funnel, conversion by rail, K-factor and the holdout comparison.

### Running the guest app

| Target | Command |
|---|---|
| iOS simulator | `open -a Simulator`, then `cd mobile && flutter run` |
| Android emulator | start an emulator from Android Studio, then `cd mobile && flutter run`. The app reaches your machine through `10.0.2.2` automatically. |
| Physical phone (same Wi-Fi) | `cd mobile && flutter run --dart-define=API_URL=http://<your-computer's-LAN-IP>:4000` |
| Pick a device | `flutter devices`, then `flutter run -d <device-id>` |

Opening an invite by **deep link** instead of typing the code:

```bash
xcrun simctl openurl booted velio://invite/CODE                                        # iOS simulator
adb shell am start -a android.intent.action.VIEW -d velio://invite/CODE                # Android emulator
```

iOS asks "Open in Velio?" the first time; tap **Open**.

Things to try on the phone: claim the same vouch twice, claim a full activity, or turn the network off mid-claim (stop the API with Ctrl-C, or use the Network Link Conditioner). The claim is queued and goes through once the API is back.

### Configuration

Everything has a working default; override with environment variables.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | API port |
| `DATABASE_URL` | `postgres://velio:velio@localhost:5442/velio` | Postgres connection |
| `REDIS_URL` | `redis://localhost:6389` | Redis for live updates |
| `DB_POOL_SIZE` | `20` | Connections per API instance |
| `WEB_URL` | `http://localhost:3000` | Base for invite links (`/i/CODE`) |
| `INVITES_ENABLED` | `true` | Kill switch for the invite feature |
| `INVITES_HOLDOUT_PCT` | `10` | Share of activities that never offer invites |
| `VOUCH_TTL_HOURS` | `168` | How long a vouch stays valid (capped at the start time) |
| `NEXT_PUBLIC_API_URL` (web) | `http://localhost:4000` | Where the web app finds the API; see `web/.env.example` |
| `API_URL` (mobile, `--dart-define`) | `localhost:4000` (iOS) / `10.0.2.2:4000` (Android) | Where the app finds the API |

**Run a second API instance** to see live updates cross instances through Redis:

```bash
cd backend && PORT=4001 npm run dev
```

### Tests

Docker must be running; the backend tests use a separate `velio_test` database, so they never touch your demo data.

```bash
cd backend && npm test          # 65 tests against real Postgres/Redis: races, edge cases, chaos, outages
cd backend && npm run typecheck
cd mobile && flutter test       # 24 tests: parsing, live updates, claim flow, offline queue, failures
cd mobile && flutter analyze
cd web && npm run build         # type-checks and builds the web app
```

**Load test** (with the API running). It fires every booking at once and checks the three technical SLOs:

```bash
cd backend && npm run loadtest
cd backend && API_URLS=http://localhost:4000,http://localhost:4001 BOOKERS=2000 SPOTS=300 npm run loadtest
```

If it fails with `EMFILE`, raise the open-file limit first: `ulimit -n 10240`. The load test creates its own activity, so reset afterwards if you want a tidy demo.

### Reset to a clean demo

```bash
docker compose down -v && docker compose up -d   # wipes Postgres and Redis (the test database is recreated too)
# restart the API (it re-applies migrations), then:
cd backend && npm run seed
```

After a reset, **uninstall the guest app** from the simulator (long-press → Remove App, or `xcrun simctl uninstall booted app.velio.velioGuest`). Otherwise it remembers a profile that no longer exists.

### Stopping everything

Ctrl-C in the API, web and Flutter terminals, then:

```bash
docker compose down        # keeps the data
docker compose down -v     # also deletes the data
```

### Troubleshooting

| Problem | Fix |
|---|---|
| `port is already allocated` from Docker | Something else uses 5442 or 6389. Stop it, or change the host ports in `docker-compose.yml` and set `DATABASE_URL` / `REDIS_URL` to match. |
| API can't connect to the database | `docker compose ps` should show both services healthy; wait a few seconds after `up -d`. |
| Web shows "We couldn't reach Velio" | The API isn't running on :4000, or `NEXT_PUBLIC_API_URL` points elsewhere. |
| iOS app is blank when opened from the home screen | Debug builds need the Flutter tool attached. Start it with `flutter run`. |
| Phone can't reach the API | On a physical device use your computer's LAN IP via `--dart-define=API_URL=…`, and make sure both are on the same network. |
| Guest app says it needs a name but shows no name field | You reset the database while the app was installed. Uninstall the app and open it again. |
| `npm test` fails with "database velio_test does not exist" | The Postgres volume predates the init script. Run `docker compose down -v && docker compose up -d`. |

---

## Architecture and decisions

```
 web (Next.js)     mobile (Flutter)
       │  REST + SSE      │
       └───────┬──────────┘
        backend (Fastify)  ── /metrics (Prometheus), /admin/report (goals)
         │            │
    PostgreSQL    Redis pub/sub
  (source of truth)  (fan-out only)
```

* **PostgreSQL is the only source of truth.** Redis carries notifications and nothing else, so losing Redis loses no bookings; clients heal by refetching on reconnect.
* **API instances are stateless.** Each subscribes to Redis and serves its own SSE clients, so scaling out needs no sticky sessions. The load test runs across two instances.

### Concurrency: never oversell

A booking is one transaction whose key statement is a conditional atomic increment ([`backend/src/services/bookings.ts`](backend/src/services/bookings.ts)):

```sql
UPDATE activities SET spots_taken = spots_taken + 1, version = version + 1
 WHERE id = $1 AND spots_taken < capacity AND starts_at > now()
RETURNING spots_taken, capacity, version;
```

Postgres row-locks the activity; queued transactions re-check `spots_taken < capacity` against the latest committed value, so exactly `capacity` of them can ever match. Zero rows means a friendly `409 SOLD_OUT`. The booking row is inserted in the same transaction, so any later failure releases the spot. Further protection:

* `CHECK (spots_taken BETWEEN 0 AND capacity)`: the database itself refuses an oversell, whatever the code does (tested).
* Unique `(activity_id, user_id) WHERE confirmed`: one spot per person, even with parallel clicks.
* Idempotency key per attempt: a retry after a lost response returns the original booking.
* Invite claims lock the invite row first, so a single-use vouch can't be claimed twice.

Why this over `SELECT … FOR UPDATE`, optimistic versioning, a Redis counter or `SERIALIZABLE`: see [PLANS.md §1b](PLANS.md#concurrency-strategy-for-the-last-spot).

**The proof** ([`backend/test/booking-concurrency.test.ts`](backend/test/booking-concurrency.test.ts)):
* 50 people fire at the last spot over real HTTP sockets → exactly 1 succeeds, 49 get `SOLD_OUT`, counts match.
* 200 people race for 20 spots → exactly 20 distinct winners.
* A transaction holds the last spot open while 9 others fire; the test **observes all 9 waiting in `pg_locks`** (so the race is genuinely concurrent), then commits and checks all 9 get `SOLD_OUT`. A rollback variant hands the spot to exactly one waiter.
* Invite claims and direct bookings racing for the last spots ([`invites.test.ts`](backend/test/invites.test.ts)).

### Real-time availability

1. The booking commits.
2. The API publishes `{activityId, spotsTaken, capacity, version, committedAt}` to Redis.
3. Every instance writes it to its SSE connections watching that activity (`GET /stream?activityIds=…`).
4. Clients apply an update only if `version` is newer, so out-of-order or duplicate messages can't show a wrong count. On reconnect, they refetch.

SSE rather than WebSockets because availability is one-way, SSE is plain HTTP and reconnects by itself. Writes stay on normal REST calls.

### Invites and attribution

* **Vouch:** names a contact, single-use, expires after 7 days or at the start time. **Public:** one reusable link per person per activity.
* Only people who are going (or the host) can invite.
* A claim is one transaction: create the guest (if new) → take a spot → count the use → write attribution. If the activity is full, nothing is kept: no orphan guest, no consumed vouch.
* `attributions` records inviter, invitee, rail, code, invite generation (`inviter.generation + 1`) and whether the invitee was new. `users.generation` is stamped once at signup.
* **History can't be rewritten:** triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on `attributions` and `events`, and any change to `users.generation` (tested).

### Feature flag and holdout

`INVITES_ENABLED` is a kill switch. `INVITES_HOLDOUT_PCT` (default 10) puts a stable 10% of **activities** (hash of id) in a holdout that never offers invites, so we can compare plans and new users with vs. without invites. Activity-level randomisation avoids leakage inside a shared plan; reasoning in [PLANS.md §1d](PLANS.md#holdout-design).

---

## Where to see the tracking

| Where | What |
|---|---|
| **http://localhost:3000/admin** | Every scope goal with value, target and status, plus funnel, conversion by rail, K-factor by rail, holdout comparison. |
| **http://localhost:4000/admin/report** | Same as JSON. |
| **http://localhost:4000/metrics** | Prometheus: `velio_booking_attempts_total{outcome,via}`, `velio_booking_duration_seconds`, `velio_availability_latency_seconds` (client-reported), `velio_availability_fanout_seconds` (server), `velio_sse_clients`, and `velio_oversold_activities` (integrity check run on every scrape). |
| SQL views | One per goal in [`002_tracking_views.sql`](backend/src/db/migrations/002_tracking_views.sql). |

```bash
docker compose exec postgres psql -U velio -d velio -c "SELECT * FROM v_goal_bookers_who_invite"
docker compose exec postgres psql -U velio -d velio -c "SELECT * FROM v_goal_invite_conversion"
docker compose exec postgres psql -U velio -d velio -c "SELECT * FROM v_k_factor_by_rail"
docker compose exec postgres psql -U velio -d velio -c "SELECT * FROM v_invite_holdout"
```

### SLO results (load test on a laptop, `npm run loadtest`)

| Run | Booked | Errors | Oversold | Booking p95 | Live update p95 |
|---|---|---|---|---|---|
| 1 instance: 1,000 bookers → 200 spots, 50 watchers | 200 / 200 | 0 | 0 | 715 ms | 10 ms |
| 2 instances: 2,000 bookers → 300 spots, 50 watchers | 300 / 300 | 0 | 0 | 1,262 ms | 7 ms |

All three technical SLOs pass: zero oversold, 100% success on available spots (target 99.5%), and live update p95 far under 2 s. Booking latency in these runs is dominated by all requests arriving in the same instant and queueing on one row; that's the deliberate worst case.

---

## Plan vs. reality

Summarised here; details in [PLANS.md](PLANS.md#plan-vs-reality). The build follows the plan. Additions: cancellation (needed to show a spot reappearing live, and the base for a waitlist) and a server-side fan-out latency metric next to the client-reported one. Not built: rate limiting, bot filtering of invite opens, auth on the admin report. The Flutter app covers the guest journey only, so guests who want to invite onwards use the web app.

## Trade-offs and shortcuts

**Prioritised:** correctness of the booking path and its proof, attribution integrity, measurable goals, and the guest's mobile flow, over breadth of features.

| Shortcut | Why it's OK here | For production |
|---|---|---|
| Identity is a user id in a header | Auth is out of scope | Real auth (phone OTP fits invited guests), the id from a session |
| `/admin/report` and `/metrics` are open | Local prototype | Behind admin auth, or internal network only |
| Events written from the API to Postgres | Simple, queryable, enough volume for a prototype | Stream to a warehouse (Kafka or a queue → BigQuery/ClickHouse); keep the views there |
| Views scan all time | Small data | Time-windowed, partitioned `events` by month, materialised daily |
| No rate limiting on booking/claim/open | Prototype | Per-user and per-IP limits; a Redis token bucket in front of very hot activities, with Postgres still the authority |
| Clock-offset latency from clients | Good enough to watch the trend; the load test measures exactly | Also track server fan-out time (already exported) |
| One plan per activity | Simplest reading of the scope | Party-level plans ("my crew") for better social features |
| Migrations are hand-rolled SQL | Two files | A migration tool with down-migrations and CI checks |
| Run the app as a DB role with only `INSERT, SELECT` on append-only tables | Triggers already enforce it | Do both |
