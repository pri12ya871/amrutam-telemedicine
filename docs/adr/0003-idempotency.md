# ADR-0003 — Insert-first idempotency keys

**Status:** Accepted · **Date:** 2026-09-20

## Context

A patient submits a booking. The response is lost to a flaky mobile connection. The client
retries. Without server-side protection the patient now has two consultations and two charges.

HTTP offers no guarantee here: `POST` is neither safe nor idempotent, and a client cannot tell a
lost response from a lost request.

## Decision

An `idempotency_keys` table with `UNIQUE (user_id, idem_key)`, and middleware that claims the key
by **inserting first**:

```sql
INSERT INTO idempotency_keys (user_id, idem_key, endpoint, request_hash, state)
VALUES ($1, $2, $3, $4, 'in_progress')
ON CONFLICT (user_id, idem_key) DO NOTHING
RETURNING id;
```

Applied to `POST /bookings`, `POST /bookings/{id}/cancel`, `POST /payments/{id}/capture`,
`POST /prescriptions`. A missing header is a `400`, not a silent pass.

## Rationale

The uniqueness decision is made by the database under its own lock, so exactly one concurrent
request can win. A `SELECT`-then-`INSERT` would leave a window in which two requests both observe
"no existing key" and both proceed — which is the duplicate this exists to prevent.

## Resolution table

| Situation | Response |
|---|---|
| Key is new | Proceed; store the response on completion |
| Key exists, request hash differs | `422 IDEMPOTENCY_KEY_REUSE` |
| Key exists, state `completed` | Replay the stored status and body, `Idempotency-Replayed: true` |
| Key exists, state `in_progress` | `409 IDEMPOTENT_REQUEST_IN_PROGRESS` |
| Key exists, state `failed` | Take over the key and retry |

## Consequences

**Good**

- Duplicate submissions are impossible, not merely unlikely.
- The request hash catches the client bug of reusing one key for different operations.
- Scoped per user, so two tenants' keys can never collide.

**Bad**

- One extra write per idempotent request. Acceptable: a booking is already a multi-statement
  transaction, and the row is small.
- The table grows and needs sweeping (hourly job, 24-hour TTL).
- Response bodies are stored, so large responses cost storage. Bounded here by small payloads.

## Only 2xx responses are stored

A `4xx` is a client error that a corrected retry should be allowed to fix; pinning it to the key
would trap the client. A `5xx` may or may not have completed its side effects, so replaying a
recorded failure could hide a success. In both cases the key is released.

## Verification

`test/integration/idempotency.test.ts` covers: missing key rejected, replay returns the identical
response, ten concurrent duplicates produce one consultation, same key with a different body is
rejected, keys are per-user, and a triple-retried payment capture charges the provider once.
