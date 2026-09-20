# ADR-0001 — Modular monolith over microservices

**Status:** Accepted · **Date:** 2026-09-20

## Context

The brief specifies "modular services with DI" and 100k consultations/day, which is often read as
a mandate for microservices.

Worked through, 100k/day is ~1.2 writes/sec averaged. Assuming a 10× peak for Indian telemedicine's
morning and evening surges, that is ~12 writes/sec and ~250 reads/sec. A single Postgres instance
on modest hardware handles this comfortably.

## Decision

One deployable with enforced module boundaries. Each module owns its routes, service and
repository; modules communicate through service interfaces and domain events, never by reading
each other's tables. Dependencies are wired in a composition root (`src/container.ts`).

## Consequences

**Good**

- The booking flow stays inside one ACID transaction. As microservices, claiming a slot and
  creating a consultation would span a service boundary and need a distributed saga for something
  Postgres already does correctly in one statement.
- One deploy, one log stream, one trace per request. A three-person team can operate it.
- Local development is `docker compose up`, not a service mesh.

**Bad**

- Everything scales together. A traffic spike on search provisions capacity for booking too.
- Module boundaries are enforced by review, not by the network. Discipline can erode.
- A memory leak or crash in any module takes the whole process down (mitigated: multiple instances).

## Revisit when

- Sustained writes exceed ~500/sec, or a single module's resource profile diverges sharply.
- More than ~4 teams are committing, and deploy contention is costing more than operational
  simplicity is saving.

The seams to cut along already exist: booking + availability first (highest write volume),
then analytics (read-heavy, replica-bound, no writes).

## Rejected alternatives

- **Microservices from day one** — distributed transactions for the core flow, plus the operational
  cost of service discovery, tracing across boundaries and per-service deploys, in exchange for
  scaling nobody needs yet.
- **Serverless functions** — cold starts sit directly in the p95 budget, and per-invocation
  connections need a pooler in front of Postgres for no gain at this volume.
