# Amrutam Telemedicine — Backend

[![CI](https://github.com/pri12ya871/amrutam-telemedicine/actions/workflows/ci.yml/badge.svg)](https://github.com/pri12ya871/amrutam-telemedicine/actions/workflows/ci.yml)

Production-grade backend for a telemedicine platform: user lifecycle, doctor availability,
race-free booking, consultation lifecycle, encrypted prescriptions, compliance audit trails and
admin analytics.

Node 20 · TypeScript · Express · PostgreSQL 16 · Redis (optional) · OpenAPI 3.1 · OpenTelemetry

**Targets:** 100k consultations/day · p95 < 200 ms reads, < 500 ms writes · 99.95% availability

---

## The two things worth looking at first

Everything else in this repository is ordinary competent backend work. These two are where the
actual engineering is.

### 1. Booking is race-free, and there is a test that proves it

Two patients tap Book on the same slot at the same millisecond. Exactly one gets it.

```sql
UPDATE availability_slots
   SET status = 'held', held_until = now() + make_interval(mins => $3), ...
 WHERE id = $1
   AND consultation_id IS NULL
   AND (status = 'available' OR (status = 'held' AND held_until < now()))
RETURNING id, doctor_id, start_at, end_at;
```

Postgres evaluates that predicate while holding the row lock, so exactly one concurrent statement
can match. The loser gets `rowCount = 0` and a `409`. No application lock, no retry loop, one
round trip — so contention never lands in p95.

> `test/integration/booking.concurrency.test.ts` fires **50 simultaneous bookings at one slot and
> asserts exactly 1 × 201 and 49 × 409**, then checks the database agrees.

Why not `SELECT`-then-`INSERT`, `FOR UPDATE`, an advisory lock or a Redis lock:
[ADR-0002](docs/adr/0002-slot-concurrency.md).

### 2. Every unsafe write is idempotent

A lost response must not become a second charge.

```sql
INSERT INTO idempotency_keys (user_id, idem_key, endpoint, request_hash, state)
VALUES ($1, $2, $3, $4, 'in_progress')
ON CONFLICT (user_id, idem_key) DO NOTHING
RETURNING id;
```

Insert-first, because a `SELECT`-then-`INSERT` has a window where two concurrent requests both see
"no existing key". Losing the race means: replay the stored response, reject a mismatched body
(`422`), or report the original still in flight (`409`).

> `test/integration/idempotency.test.ts` sends the same key ten times concurrently and asserts
> **one** consultation, and captures one payment three times asserting the provider was charged once.

[ADR-0003](docs/adr/0003-idempotency.md).

---

## Quick start

### With Docker (everything)

```bash
git clone https://github.com/pri12ya871/amrutam-telemedicine.git
cd amrutam-telemedicine
docker compose up -d --build
```

API on `http://localhost:3000`. Migrations apply automatically at boot.

```bash
docker compose exec api node --import tsx scripts/seed.ts   # demo data
curl http://localhost:3000/health/ready
```

With the observability stack:

```bash
docker compose --profile observability up -d
# Grafana   http://localhost:3001  (anonymous admin)
# Prometheus http://localhost:9090
# Jaeger    http://localhost:16686
```

### Without Docker

Needs a Postgres 16 URL. A free managed instance (Neon, Supabase, Railway) works — add
`?sslmode=require` and set `DATABASE_SSL=true`. Redis is optional; leave `REDIS_URL` blank to run
without it.

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL and generate the secrets
npm run migrate
npm run seed
npm run dev
```

Generate real secrets — do not ship the placeholders:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # DATA_MASTER_KEY  (must decode to exactly 32 bytes)
openssl rand -base64 24   # IP_HASH_SALT
```

---

## Commands

```bash
npm run dev              # watch mode
npm run build            # compile to dist/ and copy migrations
npm start                # run the build
npm run migrate          # apply migrations (idempotent, checksum-verified, advisory-locked)
npm run seed             # demo doctors, patients, an MFA-enrolled admin, two weeks of slots
npm run typecheck        # tsc --noEmit, strict
npm test                 # unit tests — no database needed
npm run test:integration # integration tests — needs Postgres
npm run test:all         # everything
npm run openapi          # regenerate openapi.yaml / openapi.json from the Zod schemas
k6 run load/booking.k6.js
```

**77 tests, all green in CI.**

The 55 unit tests need no infrastructure — crypto, TOTP against the RFC 4226 vectors, retry and
circuit breaker, the RBAC matrix, the consultation state machine. The 22 integration tests run
against real Postgres and Redis service containers on every push, and skip cleanly on a laptop
with no database so `npm test` works on a fresh clone.

---

## Walk the whole flow in one minute

```bash
# 1 — register and log in
curl -s localhost:3000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"p1@example.com","password":"a-long-enough-password-99","fullName":"Priya P"}'

TOKEN=$(curl -s localhost:3000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"p1@example.com","password":"a-long-enough-password-99"}' | jq -r .data.accessToken)

# 2 — find a doctor and a slot
DOC=$(curl -s "localhost:3000/api/v1/doctors?specialization=Ayurveda" | jq -r '.data.items[0].id')
SLOT=$(curl -s "localhost:3000/api/v1/doctors/$DOC/slots?from=$(date +%F)&to=$(date -d '+7 days' +%F)" \
  | jq -r '.data[0].id')

# 3 — book it (Idempotency-Key is mandatory)
KEY=$(uuidgen)
curl -s localhost:3000/api/v1/bookings -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: $KEY" \
  -d "{\"slotId\":\"$SLOT\",\"mode\":\"video\"}" | jq

# 4 — send the exact same request again: replayed, not duplicated
curl -si localhost:3000/api/v1/bookings -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: $KEY" \
  -d "{\"slotId\":\"$SLOT\",\"mode\":\"video\"}" | grep -i idempotency-replayed

# 5 — a second patient racing for the same slot gets 409
```

---

## API

`openapi.yaml` / `openapi.json` — **29 paths, generated from the same Zod schemas the server
validates with**, so the spec cannot drift from the implementation. Paste into
[editor.swagger.io](https://editor.swagger.io) to browse.

| Area | Endpoints |
|---|---|
| Auth | register · login · refresh · logout · MFA setup/confirm · me |
| Doctors | search/filter · profile · slots · create profile · verify (admin) |
| Availability | recurring rules · materialise slots · block a slot |
| Bookings | book (idempotent) · cancel (idempotent) |
| Payments | capture (idempotent) · list |
| Consultations | list · detail · state transition · encrypted notes |
| Prescriptions | issue (MFA + idempotent) · list · detail · revoke |
| Admin | overview · trends · top doctors · utilisation · audit-log search |
| Operations | `/health/live` · `/health/ready` · `/metrics` |

Errors are always `{ "error": { "code", "message", "requestId" } }`.

---

## Architecture in one paragraph

A **modular monolith**: one deployable, hard module boundaries, dependencies wired in a composition
root. 100k consultations/day is ~12 writes/sec at peak — one Postgres handles that comfortably, and
microservices would buy scaling nobody needs while costing distributed transactions in the one flow
where correctness is genuinely hard ([ADR-0001](docs/adr/0001-modular-monolith.md)). Booking is a
**saga**: claim the slot → hold → capture payment → confirm, with a sweeper that releases unpaid
holds. Domain events go through a **transactional outbox** so an event can never describe a state
change that did not commit. `consultations` and `audit_logs` are **month-partitioned**. Redis is
**optional by design** — every cache helper fails soft and the rate limiter fails open, because a
cache outage must not become a service outage.

📄 **[Full architecture document](docs/architecture.md)** — C4 container diagram, booking sequence
diagram, ER diagram, saga state machine, partitioning, caching, concurrency table, retry and
backoff, backup and DR.

---

## Security

📄 [Threat model](docs/threat-model.md) (STRIDE per trust boundary, data classification, OWASP API
Top 10) · [Security checklist](docs/security-checklist.md)

Highlights:

- **scrypt** password hashing; **TOTP MFA** implemented against RFC 6238 and verified against the
  RFC's own test vectors; **mandatory** for doctor and admin roles.
- **Refresh rotation with reuse detection** — replaying a used token revokes the entire family.
- **Envelope encryption** for PHI/PII: a per-record data key wrapped by a master key, with a `kid`
  column, so rotation rewraps keys instead of re-encrypting data and erasure is satisfied by
  crypto-shredding.
- **Append-only audit trail**, enforced by a database trigger, covering clinical **reads** as well
  as writes — a write-only log cannot answer "who looked at this patient's prescription".
- Object-level authorisation checked against the row, returning 404 rather than 403 so ids cannot
  be probed.
- Raw IP addresses are never stored; only a salted HMAC.

---

## Observability

- **Metrics** — `/metrics`, RED per route plus booking, idempotency, outbox and auth counters.
  Histogram buckets sit either side of the SLO thresholds, because that is where the alert fires.
- **Logs** — pino JSON, correlated by `requestId` via `AsyncLocalStorage`, with clinical fields on
  the redact list.
- **Traces** — OpenTelemetry auto-instrumentation across HTTP, Postgres and Redis → Jaeger.
- **Alerts** — `observability/alerts.yml`, derived from the SLOs; each names the user-visible
  symptom it protects.

---

## CI

`.github/workflows/ci.yml` — four jobs:

| Job | What it does |
|---|---|
| **quality** | typecheck · build · 55 unit tests |
| **integration** | real Postgres + Redis service containers · migrations · concurrency and idempotency suites |
| **security** | `npm audit` (high+, prod deps) · gitleaks over full history · CodeQL |
| **image** | multi-stage Docker build · Trivy scan (HIGH/CRITICAL fail, **0 findings**) · smoke test |

The image smoke test starts the container **with no database reachable** and asserts liveness still
answers — proving the process starts before its dependencies and that readiness, not liveness, is
what gates traffic.

---

## Not built, and said so plainly

Under a compressed timebox, scope was cut deliberately rather than faked:

| Not built | What *is* built around it |
|---|---|
| Real payment gateway | `MockPaymentProvider` behind a `PaymentProvider` interface. The retry schedule, circuit breaker, saga compensation and idempotency are all real and tested. |
| Video/WebRTC media | `mode` is modelled; signalling is out of scope. |
| Email/SMS delivery | Events flow through the outbox with backoff and dead-lettering; handlers log instead of calling a provider. |
| Read-replica routing | Analytics queries are written replica-safe and the topology is designed; the connection split is not wired. |
| Managed KMS | Envelope encryption with per-record DEKs and a `kid` column is implemented; the master key comes from an env var. Rotation procedure documented. |
| Measured k6 results | The load script and thresholds are committed. Numbers are only meaningful against the Compose stack or CI containers — not a free-tier database whose cold starts would make them fiction. |

---

## Layout

```
src/
├── config.ts              env parsed and validated once, at boot
├── container.ts           composition root
├── app.ts  index.ts       Express wiring · bootstrap and graceful shutdown
├── db/                    pool, migration runner, SQL migrations
├── cache/                 fail-soft Redis helpers
├── lib/                   errors · logger · async context · crypto · TOTP · retry
├── telemetry/             Prometheus metrics · OpenTelemetry tracing
├── middleware/            auth+RBAC · idempotency · rate limit · validation · errors
├── modules/               auth doctors availability booking consultations
│                          prescriptions payments admin audit
└── jobs/                  outbox relay · scheduled sweeps
docs/     architecture · threat-model · security-checklist · adr/
test/     unit (no infra) · integration (Postgres)
```

## Licence

MIT
