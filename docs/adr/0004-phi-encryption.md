# ADR-0004 — Envelope encryption for PHI

**Status:** Accepted · **Date:** 2026-09-20

## Context

This system stores diagnoses, symptoms, clinical notes and prescriptions. Under India's DPDP Act
2023 that is sensitive personal data; under HIPAA it would be PHI. Diagnosis plus medication
history is enough to infer conditions a patient may not have disclosed to anyone else.

Disk-level encryption (which the managed database provides) protects against a stolen disk. It
does nothing against a leaked backup, an over-privileged read-only analyst, an SQL injection that
reaches `SELECT`, or a support engineer with production console access.

## Decision

Application-level **envelope encryption** for PII and PHI columns:

- Every record gets a random 256-bit data key (DEK).
- The payload is encrypted AES-256-GCM under that DEK.
- The DEK is encrypted under a master key and stored beside the ciphertext.
- A `kid` column records which master key wrapped it.

Encrypted: `mfa_secret_enc`, `phone_enc`, `address_enc`, `chief_complaint_enc`, `notes_enc`,
`payload_enc`.

## Rationale

Per-record DEKs give two properties a single key does not:

1. **Rotation is cheap.** Rotating the master key rewraps DEKs — a small write per row — rather
   than re-encrypting every clinical payload.
2. **Crypto-shredding.** Destroying one record's DEK makes that record unrecoverable, including in
   backups that cannot be rewritten. That is how an erasure request is honoured against a 30-day
   PITR window.

GCM is authenticated, so tampered ciphertext fails to decrypt rather than returning plausible
garbage.

## Consequences

**Good**

- A database dump without the master key yields no clinical data.
- Erasure is satisfiable without rewriting history.
- The key id makes rotation auditable per record.

**Bad**

- **Encrypted columns are not queryable.** No `WHERE diagnosis LIKE …`, no index on symptoms.
  Accepted: clinical text was never a sound search axis, and analytics uses counts and status,
  never content.
- A decrypt cost per read. Negligible — AES-GCM is hardware-accelerated — but real at volume.
- The master key becomes the single most sensitive secret in the system.

## Key rotation

1. Add the new key as `DATA_MASTER_KEY_NEXT`; deploy. Decryption tries both.
2. Run the rewrap job: for each row, unwrap with the old key, rewrap with the new, set `kid`.
3. Once no row carries the old `kid`, retire the old key.

No downtime, no re-encryption of payloads, and progress is measurable by counting `kid` values.

## Known gap

The master key currently comes from an environment variable, not a managed KMS. The `kid` column
and the wrapping structure are exactly what a KMS integration needs, so the change is confined to
`src/lib/crypto.ts`. Documented in `docs/architecture.md` §8 rather than left to be discovered.
