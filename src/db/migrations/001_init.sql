-- 001_init.sql — core schema.
-- Design rationale lives in docs/architecture.md; the invariants that must not
-- be relaxed are called out inline, because they are what keep booking correct
-- under concurrency.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- identity

DO $mig$ BEGIN
  CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $mig$;

DO $mig$ BEGIN
  CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $mig$;

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  password_hash   text   NOT NULL,
  password_algo   text   NOT NULL DEFAULT 'scrypt',
  role            user_role   NOT NULL DEFAULT 'patient',
  status          user_status NOT NULL DEFAULT 'active',
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_secret_enc  jsonb,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  phone_enc     jsonb,
  date_of_birth date,
  gender        text,
  city          text,
  address_enc   jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh-token families. Rotation plus reuse detection: presenting a token
-- that has already been rotated revokes the entire family, which is the
-- standard response to a stolen refresh token.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  parent_id   uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_user   ON refresh_tokens(user_id);

-- ---------------------------------------------------------------- doctors

DO $mig$ BEGIN
  CREATE TYPE doctor_status AS ENUM ('pending_verification', 'active', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $mig$;

CREATE TABLE IF NOT EXISTS doctors (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  registration_no        text NOT NULL UNIQUE,
  specializations        text[] NOT NULL DEFAULT '{}',
  languages              text[] NOT NULL DEFAULT '{}',
  years_experience       integer NOT NULL DEFAULT 0 CHECK (years_experience >= 0),
  consultation_fee_paise bigint NOT NULL CHECK (consultation_fee_paise >= 0),
  city                   text,
  bio                    text,
  rating                 numeric(3,2) NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  rating_count           integer NOT NULL DEFAULT 0,
  status                 doctor_status NOT NULL DEFAULT 'pending_verification',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Search path. GIN on the array columns turns "&& ARRAY[...]" overlap into an
-- index scan; the composite btree covers the common status+fee+experience
-- filter and sort.
CREATE INDEX IF NOT EXISTS idx_doctors_specializations ON doctors USING gin (specializations);
CREATE INDEX IF NOT EXISTS idx_doctors_languages       ON doctors USING gin (languages);
CREATE INDEX IF NOT EXISTS idx_doctors_active_fee      ON doctors (status, consultation_fee_paise, years_experience DESC);
CREATE INDEX IF NOT EXISTS idx_doctors_city            ON doctors (lower(city)) WHERE status = 'active';

-- Recurring weekly availability. Slots are materialised from these rules so the
-- booking path never computes a recurrence at request time.
CREATE TABLE IF NOT EXISTS availability_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id    uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  slot_minutes integer NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 5 AND 240),
  timezone     text NOT NULL DEFAULT 'Asia/Kolkata',
  valid_from   date NOT NULL DEFAULT CURRENT_DATE,
  valid_to     date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS idx_rules_doctor ON availability_rules(doctor_id, weekday);

DO $mig$ BEGIN
  CREATE TYPE slot_status AS ENUM ('available', 'held', 'booked', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $mig$;

CREATE TABLE IF NOT EXISTS availability_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  status      slot_status NOT NULL DEFAULT 'available',
  hold_token  uuid,
  held_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  held_until  timestamptz,
  -- The consultation currently occupying this slot. This column, not anything
  -- on the consultations table, is where "one booking per slot" is enforced —
  -- see INVARIANT 2 below.
  consultation_id uuid,
  version     integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- INVARIANT 1: a doctor cannot have two slots at the same instant. This makes
  -- slot generation idempotent (ON CONFLICT DO NOTHING) and stops overlapping
  -- slots from being representable at all.
  CONSTRAINT uq_slot_per_doctor UNIQUE (doctor_id, start_at)
);
CREATE INDEX IF NOT EXISTS idx_slots_lookup ON availability_slots (doctor_id, start_at)
  WHERE status = 'available';
-- Drives the hold-expiry sweeper without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_slots_expiring ON availability_slots (held_until)
  WHERE status = 'held';
-- INVARIANT 2 (see consultations): a consultation can occupy at most one slot,
-- and a slot at most one consultation. This is the database-level backstop
-- behind the conditional UPDATE in bookingService.claimSlot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_consultation
  ON availability_slots (consultation_id) WHERE consultation_id IS NOT NULL;

-- -------------------------------------------------- consultations (partitioned)

DO $mig$ BEGIN
  CREATE TYPE consultation_status AS ENUM
    ('pending_payment','scheduled','in_progress','completed','cancelled','no_show');
EXCEPTION WHEN duplicate_object THEN NULL; END $mig$;

DO $mig$ BEGIN
  CREATE TYPE consultation_mode AS ENUM ('video','audio','chat','in_person');
EXCEPTION WHEN duplicate_object THEN NULL; END $mig$;

-- Range-partitioned by month. At 100k consultations/day a single heap reaches
-- ~36M rows/year; monthly partitions keep index depth and autovacuum bounded
-- and make retention a DETACH rather than a mass DELETE.
-- A partitioned table requires the partition key in every unique constraint,
-- hence the composite (id, created_at) primary key.
CREATE TABLE IF NOT EXISTS consultations (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  patient_id          uuid NOT NULL REFERENCES users(id),
  doctor_id           uuid NOT NULL REFERENCES doctors(id),
  slot_id             uuid NOT NULL,
  status              consultation_status NOT NULL DEFAULT 'pending_payment',
  mode                consultation_mode   NOT NULL DEFAULT 'video',
  scheduled_at        timestamptz NOT NULL,
  started_at          timestamptz,
  ended_at            timestamptz,
  chief_complaint_enc jsonb,
  notes_enc           jsonb,
  cancel_reason       text,
  cancelled_by        uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- INVARIANT 2: one live consultation per slot.
--
-- Note where this is NOT enforced. A unique index on a partitioned table must
-- contain the partition key, so `UNIQUE (slot_id, created_at)` on
-- consultations would permit two rows with the same slot_id and different
-- timestamps — the exact thing it appears to forbid. Writing it would be worse
-- than writing nothing, because it reads like a guarantee.
--
-- The invariant therefore lives on availability_slots, which is not
-- partitioned: see uq_slot_consultation below. A slot holds at most one
-- consultation id, and the transition into that state is a single conditional
-- UPDATE, so two concurrent bookings cannot both succeed.
CREATE INDEX IF NOT EXISTS idx_consult_slot ON consultations (slot_id);

CREATE INDEX IF NOT EXISTS idx_consult_patient ON consultations (patient_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_consult_doctor  ON consultations (doctor_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_consult_status  ON consultations (status, scheduled_at);

-- ---------------------------------------------------------------- prescriptions

CREATE TABLE IF NOT EXISTS prescriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL,
  doctor_id       uuid NOT NULL REFERENCES doctors(id),
  patient_id      uuid NOT NULL REFERENCES users(id),
  payload_enc     jsonb NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  valid_until     date,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rx_consultation ON prescriptions (consultation_id);
CREATE INDEX IF NOT EXISTS idx_rx_patient      ON prescriptions (patient_id, issued_at DESC);

-- ---------------------------------------------------------------- payments

DO $mig$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending','authorized','captured','failed','refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $mig$;

CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL,
  patient_id      uuid NOT NULL REFERENCES users(id),
  amount_paise    bigint NOT NULL CHECK (amount_paise > 0),
  currency        char(3) NOT NULL DEFAULT 'INR',
  status          payment_status NOT NULL DEFAULT 'pending',
  provider        text NOT NULL DEFAULT 'mock',
  provider_ref    text,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_provider_ref
  ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_consultation ON payments (consultation_id);

-- ---------------------------------------------------------------- idempotency

-- Every unsafe, non-idempotent write goes through this table. The middleware
-- inserts first (ON CONFLICT DO NOTHING); losing that race means another
-- request with the same key is either in flight (409) or finished (replay).
DO $mig$ BEGIN
  CREATE TYPE idempotency_state AS ENUM ('in_progress','completed','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $mig$;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idem_key        text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  state           idempotency_state NOT NULL DEFAULT 'in_progress',
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  CONSTRAINT uq_idem_user_key UNIQUE (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_idem_expiry ON idempotency_keys (expires_at);

-- -------------------------------------------------------- audit (partitioned)

CREATE TABLE IF NOT EXISTS audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  actor_id      uuid,
  actor_role    text,
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  outcome       text NOT NULL DEFAULT 'success',
  ip_hash       text,
  user_agent    text,
  request_id    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs (resource_type, resource_id, created_at DESC);

-- Append-only. Tamper resistance is a compliance requirement, so it is enforced
-- by the database rather than by convention.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_logs;
CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- ---------------------------------------------------------------- outbox

-- Transactional outbox: a domain event is written in the same transaction as
-- the state change it describes, then relayed asynchronously. This is what
-- makes "consultation booked -> notify" reliable without a distributed
-- transaction across Postgres and the notification provider.
CREATE TABLE IF NOT EXISTS outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic           text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (next_attempt_at)
  WHERE status = 'pending';
