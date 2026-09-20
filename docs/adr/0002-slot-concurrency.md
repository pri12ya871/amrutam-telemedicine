# ADR-0002 — Conditional UPDATE for slot concurrency

**Status:** Accepted · **Date:** 2026-09-20

## Context

Two patients booking the same slot at the same instant must produce exactly one consultation. This
is the one place in the system where a concurrency bug is a clinical and financial incident rather
than a data-quality annoyance: a double-booked doctor, two charged patients, and nobody discovers
it until someone joins an empty call.

## Decision

Claim the slot with a single conditional `UPDATE` whose precondition lives in the `WHERE` clause:

```sql
UPDATE availability_slots
   SET status = 'held', held_until = now() + make_interval(mins => $3), ...
 WHERE id = $1
   AND consultation_id IS NULL
   AND (status = 'available' OR (status = 'held' AND held_until < now()))
RETURNING ...;
```

`rowCount = 0` means the slot was taken → `409`.

Backstop the invariant in the schema with
`UNIQUE (consultation_id) WHERE consultation_id IS NOT NULL` on `availability_slots`.

## Rationale

Postgres evaluates the predicate while holding the row lock it just took, so exactly one concurrent
statement can match. Correctness comes from the database's own locking, not from application code
being careful.

## Consequences

**Good**

- One round trip. No lock held across application latency, so contention does not inflate p95.
- The loser gets a fact (`rowCount = 0`), not an exception to interpret.
- An expired hold is reclaimed in the same statement, so a slot is never dead time.

**Bad**

- The invariant is expressed in SQL rather than in a domain object; a reader has to look at the
  query to see it. Mitigated by comments at the call site and by the unique index.
- Requires the hold-expiry sweeper to exist, which is an extra moving part.

## Note on where the constraint lives

`consultations` is range-partitioned, and a unique index on a partitioned table must include the
partition key. `UNIQUE (slot_id, created_at)` would therefore allow two rows with the same
`slot_id` and different timestamps — the precise thing it appears to prevent. It was deliberately
**not** written, because a constraint that reads like a guarantee and is not one is worse than no
constraint. The invariant lives on `availability_slots`, which is not partitioned.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| `SELECT` then `INSERT` | A window between the statements; under READ COMMITTED both transactions see the pre-write state. This *is* the bug. |
| `SELECT … FOR UPDATE` | Correct, but holds a lock across round trips; the queue lands in p95. |
| `pg_advisory_xact_lock(slot_id)` | Correct and serialising, and moves the invariant into a convention nothing enforces. |
| SERIALIZABLE isolation | Correct, but pays serialisation-failure retries on every transaction to fix one statement. |
| Redis `SETNX` | Makes booking correctness depend on the component explicitly allowed to fail. |

## Verification

`test/integration/booking.concurrency.test.ts` — 50 simultaneous requests for one slot must yield
exactly 1 × 201 and 49 × 409, with the database state asserted afterwards. Runs on every CI push
against real Postgres.
