-- Core schema for group bookings, invites and attribution.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shared guard: append-only tables reject any change to history.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END $$;

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  -- Hops from an organic user: 0 = organic, n+1 = invited by a generation-n user.
  generation  int  NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Generation is stamped at signup and never rewritten.
CREATE FUNCTION forbid_generation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generation IS DISTINCT FROM OLD.generation THEN
    RAISE EXCEPTION 'users.generation is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_generation_immutable BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION forbid_generation_change();

CREATE TABLE activities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id           uuid NOT NULL REFERENCES users(id),
  title             text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description       text NOT NULL DEFAULT '',
  location          text NOT NULL DEFAULT '',
  starts_at         timestamptz NOT NULL,
  price_cents       int  NOT NULL CHECK (price_cents >= 0),
  currency          text NOT NULL DEFAULT 'USD',
  capacity          int  NOT NULL CHECK (capacity BETWEEN 1 AND 10000),
  spots_taken       int  NOT NULL DEFAULT 0,
  -- Increments on every availability change so clients can drop stale updates.
  version           bigint NOT NULL DEFAULT 0,
  -- Stable 0-99 bucket for the invite holdout, stamped at creation.
  experiment_bucket smallint NOT NULL CHECK (experiment_bucket BETWEEN 0 AND 99),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Last line of defence against overselling, whatever the application does.
  CONSTRAINT spots_within_capacity CHECK (spots_taken BETWEEN 0 AND capacity)
);
CREATE INDEX activities_starts_at ON activities (starts_at);
CREATE INDEX activities_host ON activities (host_id);

-- Everyone going to an activity is in one plan together.
CREATE TABLE plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL UNIQUE REFERENCES activities(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  activity_id   uuid NOT NULL REFERENCES activities(id),
  inviter_id    uuid NOT NULL REFERENCES users(id),
  rail          text NOT NULL CHECK (rail IN ('vouch', 'public')),
  -- Who a vouch is for. Public links have no contact.
  contact_label text,
  max_uses      int,
  uses          int NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vouch_is_personal CHECK (
    (rail = 'vouch'  AND contact_label IS NOT NULL AND max_uses = 1) OR
    (rail = 'public' AND contact_label IS NULL)
  ),
  CONSTRAINT uses_within_max CHECK (uses >= 0 AND (max_uses IS NULL OR uses <= max_uses))
);
CREATE INDEX invites_inviter ON invites (inviter_id);
CREATE INDEX invites_activity ON invites (activity_id);

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id     uuid NOT NULL REFERENCES activities(id),
  plan_id         uuid NOT NULL REFERENCES plans(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  invite_id       uuid REFERENCES invites(id),
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz
);
-- A person holds at most one live spot per activity.
CREATE UNIQUE INDEX bookings_one_live_per_user ON bookings (activity_id, user_id) WHERE status = 'confirmed';
CREATE INDEX bookings_user ON bookings (user_id);

-- Who invited whom. Written in the same transaction as the claim; never changed afterwards.
CREATE TABLE attributions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitee_id   uuid NOT NULL REFERENCES users(id),
  inviter_id   uuid NOT NULL REFERENCES users(id),
  invite_id    uuid NOT NULL REFERENCES invites(id),
  rail         text NOT NULL CHECK (rail IN ('vouch', 'public')),
  code         text NOT NULL,
  activity_id  uuid NOT NULL REFERENCES activities(id),
  booking_id   uuid NOT NULL REFERENCES bookings(id),
  -- Generation of the invitee as a result of this invite (inviter.generation + 1).
  generation   int  NOT NULL CHECK (generation >= 1),
  -- True when this invite brought a brand-new user to Velio (counts towards K-factor).
  is_new_user  boolean NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invite_id, invitee_id),
  CHECK (invitee_id <> inviter_id)
);
CREATE INDEX attributions_inviter ON attributions (inviter_id);
CREATE TRIGGER attributions_append_only BEFORE UPDATE OR DELETE ON attributions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER attributions_no_truncate BEFORE TRUNCATE ON attributions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Product and technical event log. Append-only.
CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  user_id     uuid,
  device_id   text,
  activity_id uuid,
  invite_id   uuid,
  rail        text,
  props       jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_name_time ON events (name, created_at);
CREATE INDEX events_invite ON events (invite_id) WHERE invite_id IS NOT NULL;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
