-- One view per scope goal, so every target can be answered with a single SELECT.

-- Experiment settings the views need. The API keeps this in sync with its config on startup.
CREATE TABLE experiment_config (
  key   text PRIMARY KEY,
  value int  NOT NULL
);
INSERT INTO experiment_config VALUES ('invites_holdout_pct', 10);

CREATE FUNCTION invites_holdout_pct() RETURNS int LANGUAGE sql STABLE AS $$
  SELECT value FROM experiment_config WHERE key = 'invites_holdout_pct'
$$;

-- ---------------------------------------------------------------------------
-- Technical goals
-- ---------------------------------------------------------------------------

-- Never oversell: must always return 0.
CREATE VIEW v_slo_oversold AS
SELECT count(*)::int AS oversold_activities, 0 AS target
  FROM activities a
  LEFT JOIN (SELECT activity_id, count(*) AS c FROM bookings WHERE status = 'confirmed' GROUP BY 1) b
         ON b.activity_id = a.id
 WHERE a.spots_taken > a.capacity OR COALESCE(b.c, 0) <> a.spots_taken;

-- Bookings succeed when spots exist. Sold-out and already-booked are correct answers,
-- not failures, so the denominator is success + server errors.
CREATE VIEW v_slo_booking_success AS
WITH outcomes AS (
  SELECT
    count(*) FILTER (WHERE name = 'booking_attempted')::int                         AS attempts,
    count(*) FILTER (WHERE name = 'booking_succeeded')::int                         AS succeeded,
    count(*) FILTER (WHERE name = 'booking_sold_out')::int                          AS sold_out,
    count(*) FILTER (WHERE name = 'booking_failed' AND props->>'outcome' = 'error')::int    AS errors,
    count(*) FILTER (WHERE name = 'booking_failed' AND props->>'outcome' = 'rejected')::int AS rejected
  FROM events
  WHERE name IN ('booking_attempted', 'booking_succeeded', 'booking_sold_out', 'booking_failed')
)
SELECT attempts, succeeded, sold_out, errors, rejected,
       round(100.0 * succeeded / NULLIF(succeeded + errors, 0), 3) AS success_rate_pct,
       99.5 AS target_pct
  FROM outcomes;

-- Availability feels live: client-reported booking → update latency.
CREATE VIEW v_slo_availability_latency AS
SELECT count(*)::int AS samples,
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY (props->>'latency_ms')::numeric)::numeric, 0) AS p50_ms,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY (props->>'latency_ms')::numeric)::numeric, 0) AS p95_ms,
       round(percentile_cont(0.99) WITHIN GROUP (ORDER BY (props->>'latency_ms')::numeric)::numeric, 0) AS p99_ms,
       2000 AS target_p95_ms
  FROM events
 WHERE name = 'availability_received';

-- ---------------------------------------------------------------------------
-- Product goals
-- ---------------------------------------------------------------------------

-- Bookers become inviters (target 30%). Measured per booking: did this person invite to the
-- activity they booked? Holdout activities are excluded because inviting isn't offered there.
CREATE VIEW v_goal_bookers_who_invite AS
WITH booked AS (
  SELECT DISTINCT ON (b.user_id, b.activity_id) b.user_id, b.activity_id, (b.invite_id IS NOT NULL) AS via_invite
    FROM bookings b
    JOIN activities a ON a.id = b.activity_id
   WHERE a.experiment_bucket >= invites_holdout_pct()
   ORDER BY b.user_id, b.activity_id, b.created_at
),
invited AS (SELECT DISTINCT inviter_id, activity_id FROM invites)
SELECT CASE WHEN GROUPING(bk.via_invite) = 1 THEN 'all bookers'
            WHEN bk.via_invite THEN 'invited guests'
            ELSE 'direct bookers' END                                     AS segment,
       count(*)::int                                                       AS bookers,
       count(i.inviter_id)::int                                            AS inviters,
       round(100.0 * count(i.inviter_id) / NULLIF(count(*), 0), 1)         AS invite_rate_pct,
       30 AS target_pct
  FROM booked bk
  LEFT JOIN invited i ON i.inviter_id = bk.user_id AND i.activity_id = bk.activity_id
 GROUP BY GROUPING SETS ((), (bk.via_invite));

-- Invites turn into guests (target 25%). An open is a unique (invite, device); the inviter
-- previewing their own link doesn't count. Reported per rail because vouch and public differ.
CREATE VIEW v_goal_invite_conversion AS
WITH opens AS (
  SELECT COALESCE(rail, 'all') AS rail, count(DISTINCT (invite_id, COALESCE(device_id, user_id::text, id::text)))::int AS n
    FROM events
   WHERE name = 'invite_opened' AND COALESCE(props->>'is_inviter', 'false') <> 'true'
   GROUP BY ROLLUP (rail)
),
claims AS (
  SELECT COALESCE(rail, 'all') AS rail, count(*)::int AS n FROM attributions GROUP BY ROLLUP (rail)
)
SELECT rail,
       COALESCE(o.n, 0)                                             AS unique_opens,
       COALESCE(c.n, 0)                                             AS claimed,
       round(100.0 * COALESCE(c.n, 0) / NULLIF(o.n, 0), 1)          AS conversion_pct,
       25 AS target_pct
  FROM opens o
  FULL JOIN claims c USING (rail);

-- Core metric: K-factor = new users brought in per existing user, split by rail.
-- Existing users = people who could invite (booked or hosted an invite-enabled activity).
CREATE VIEW v_k_factor_by_rail AS
WITH eligible AS (
  SELECT count(DISTINCT u)::int AS n FROM (
    SELECT b.user_id AS u FROM bookings b JOIN activities a ON a.id = b.activity_id
     WHERE a.experiment_bucket >= invites_holdout_pct()
    UNION
    SELECT host_id FROM activities WHERE experiment_bucket >= invites_holdout_pct()
  ) x
),
by_rail AS (
  SELECT r.rail,
         count(DISTINCT i.inviter_id)::int                                    AS inviters,
         (SELECT count(*)::int FROM attributions a WHERE a.rail = r.rail AND a.is_new_user) AS new_users,
         (SELECT count(*)::int FROM attributions a WHERE a.rail = r.rail)                   AS all_claims
    FROM (VALUES ('vouch'), ('public')) r(rail)
    LEFT JOIN invites i ON i.rail = r.rail
   GROUP BY r.rail
)
SELECT r.rail, r.new_users, r.all_claims, r.inviters, e.n AS existing_users,
       round(r.new_users::numeric / NULLIF(e.n, 0), 3)        AS k_factor,
       round(r.new_users::numeric / NULLIF(r.inviters, 0), 2) AS new_users_per_inviter
  FROM by_rail r CROSS JOIN eligible e
UNION ALL
SELECT 'all', sum(r.new_users)::int, sum(r.all_claims)::int, (SELECT count(DISTINCT inviter_id)::int FROM invites), e.n,
       round(sum(r.new_users)::numeric / NULLIF(e.n, 0), 3),
       round(sum(r.new_users)::numeric / NULLIF((SELECT count(DISTINCT inviter_id) FROM invites), 0), 2)
  FROM by_rail r CROSS JOIN eligible e
 GROUP BY e.n;

-- Core metric: plans that actually happen. Proxy until check-in exists: the activity has
-- started and still had at least 2 people going.
CREATE VIEW v_plans_happened AS
SELECT count(*)::int                                                     AS past_activities,
       count(*) FILTER (WHERE spots_taken >= 2)::int                     AS happened,
       round(100.0 * count(*) FILTER (WHERE spots_taken >= 2) / NULLIF(count(*), 0), 1) AS happened_pct
  FROM activities
 WHERE starts_at <= now();

-- Funnel: viewed → booked → invite created → invite opened → claimed.
CREATE VIEW v_invite_funnel AS
SELECT 1 AS step, 'activity viewed' AS stage,
       (SELECT count(DISTINCT COALESCE(user_id::text, device_id)) FROM events WHERE name = 'activity_viewed')::int AS people
UNION ALL
SELECT 2, 'booked', (SELECT count(DISTINCT user_id) FROM bookings)::int
UNION ALL
SELECT 3, 'created an invite', (SELECT count(DISTINCT inviter_id) FROM invites)::int
UNION ALL
SELECT 4, 'invite opened',
       (SELECT count(DISTINCT (invite_id, COALESCE(device_id, user_id::text, id::text))) FROM events
         WHERE name = 'invite_opened' AND COALESCE(props->>'is_inviter', 'false') <> 'true')::int
UNION ALL
SELECT 5, 'spot claimed', (SELECT count(*) FROM attributions)::int;

-- Cause, not correlation: compare treatment and holdout activities. Randomisation is per
-- activity, so engaged users are spread evenly across both arms.
CREATE VIEW v_invite_holdout AS
WITH first_booking AS (
  SELECT DISTINCT ON (user_id) user_id, activity_id FROM bookings ORDER BY user_id, created_at
),
per_activity AS (
  SELECT a.id,
         CASE WHEN a.experiment_bucket < invites_holdout_pct() THEN 'holdout' ELSE 'treatment' END AS arm,
         a.capacity, a.spots_taken,
         (SELECT count(*) FROM first_booking f WHERE f.activity_id = a.id) AS users_acquired
    FROM activities a
)
SELECT arm,
       count(*)::int                                                         AS activities,
       round(avg(100.0 * spots_taken / capacity), 1)                         AS avg_fill_pct,
       round(100.0 * count(*) FILTER (WHERE spots_taken >= 2) / count(*), 1) AS pct_with_2plus,
       round(avg(users_acquired), 2)                                         AS first_time_bookers_per_activity
  FROM per_activity
 GROUP BY arm;
