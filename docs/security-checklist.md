# Security checklist

Each row states where the control lives, so a reviewer can verify it rather than take it on trust.
`—` in the Status column means implemented; anything else is called out honestly.

## Authentication

| Control | Status | Where |
|---|---|---|
| Memory-hard password hashing (scrypt, N=2¹⁶) | ✅ | `src/lib/crypto.ts` |
| Password policy: length-based, NIST SP 800-63B, common-password deny-list | ✅ | `src/modules/auth/authSchemas.ts` |
| No composition rules (they push users to predictable substitutions) | ✅ | deliberate |
| Account lockout: 5 failures → 15 min, decided in SQL | ✅ | `authRepository.recordFailedLogin` |
| Timing- and message-equalised login failures | ✅ | `authService.login` |
| TOTP MFA (RFC 6238), written against the spec | ✅ | `src/lib/totp.ts` |
| MFA mandatory for doctor and admin roles | ✅ | `requireMfa` on privileged routes |
| MFA secret encrypted at rest | ✅ | `mfa_secret_enc` |
| Two-step MFA enrolment (not active until a code is verified) | ✅ | `/auth/mfa/setup` → `/auth/mfa/confirm` |
| Short access tokens (15 min) | ✅ | `config.ACCESS_TOKEN_TTL` |
| Refresh rotation, single-use | ✅ | `authService.refresh` |
| **Reuse detection revokes the whole family** | ✅ | `authService.refresh` |
| Refresh tokens stored hashed, never raw | ✅ | `sha256` before insert |
| JWT algorithm pinned at verification | ✅ | `verifyAccessToken`, `algorithms: ['HS256']` |
| Issuer and audience validated | ✅ | same |
| WebAuthn / passkeys | ❌ | Gap — TOTP does not stop a real-time phishing proxy |

## Authorisation

| Control | Status | Where |
|---|---|---|
| Central RBAC permission matrix | ✅ | `src/middleware/auth.ts` |
| Routes declare permissions, not inline role checks | ✅ | `requirePermission(...)` |
| Row-level ownership on every resource read | ✅ | each service's `getById` |
| Non-participants get 404, not 403 | ✅ | avoids id probing |
| Admins cannot prescribe (no clinical authority) | ✅ | asserted in `authorization.test.ts` |
| `role: admin` rejected at registration | ✅ | `registerSchema` |
| Step-up MFA on the highest-consequence writes | ✅ | prescriptions, doctor verification, admin |
| Matrix asserted by tests | ✅ | `test/unit/authorization.test.ts` |

## Input handling

| Control | Status | Where |
|---|---|---|
| Every request body, query and param validated | ✅ | `validate()` + Zod |
| Handlers read `req.valid`, never `req.body` | ✅ | prevents mass assignment |
| All SQL values parameterised | ✅ | throughout |
| Interpolated identifiers come from closed maps only | ✅ | `SORT_COLUMNS`, `GROUP_TRUNC` |
| Body size limit (100 kb) | ✅ | `express.json` |
| Array and string lengths bounded | ✅ | Zod schemas |
| Pagination limits capped | ✅ | max 100–200 per endpoint |

## Data protection

| Control | Status | Where |
|---|---|---|
| Envelope encryption, per-record DEK | ✅ | `src/lib/crypto.ts` |
| AES-256-GCM (authenticated) | ✅ | tampering fails closed |
| Key id stored per record for rotation | ✅ | `kid` field |
| PHI never written to logs | ✅ | pino redact list |
| Raw IPs never stored — salted HMAC only | ✅ | `hashIp` |
| Audit metadata stores counts, not content | ✅ | e.g. `medicineCount` |
| Money as integer paise, never float | ✅ | `bigint` columns |
| TLS in transit | ✅ | terminated at the load balancer; HSTS preloaded |
| Managed KMS for the master key | ❌ | Gap — env var today, structure is KMS-ready (ADR-0004) |

### Key rotation procedure

1. Deploy with `DATA_MASTER_KEY_NEXT` set; decryption accepts both keys.
2. Run the rewrap job — unwrap each DEK with the old key, rewrap with the new, update `kid`.
3. When `SELECT DISTINCT payload_enc->>'kid'` no longer returns the old id, retire the old key.

No downtime and no re-encryption of payloads, because only the wrapped DEK changes.

## Audit and compliance

| Control | Status | Where |
|---|---|---|
| Every clinical **read** audited | ✅ | consultation and prescription services |
| Every state change audited, inside the transaction | ✅ | `auditInTransaction` |
| Audit log append-only, enforced by trigger | ✅ | `001_init.sql`, asserted in tests |
| Actor, role, request id, hashed IP, user agent recorded | ✅ | `auditService` |
| Reading the audit trail is itself privileged and audited | ✅ | admin router |
| Audit retention 2 years, partitioned monthly | ✅ | `002_partitions.sql` |
| Crypto-shredding for erasure requests | ✅ | destroy the record's DEK |
| Cryptographic chaining / external WORM storage | ❌ | Gap — a DB superuser could disable the trigger |

## Transport and headers

| Control | Status |
|---|---|
| helmet with tightened CSP (`default-src 'none'`) | ✅ |
| HSTS, 1 year, includeSubDomains, preload | ✅ |
| `Referrer-Policy: no-referrer` | ✅ |
| CORS allow-list, origin never reflected | ✅ |
| `x-powered-by` disabled | ✅ |
| `trust proxy: 1` — one hop, so clients cannot spoof `X-Forwarded-For` | ✅ |

## Availability

| Control | Status |
|---|---|
| Per-IP limit on unauthenticated auth routes | ✅ |
| Per-user limits on reads and writes, separate buckets | ✅ |
| Rate limiter fails open (deliberate; WAF is the backstop) | ⚠️ documented trade |
| `statement_timeout` 10 s | ✅ |
| Request and header timeouts | ✅ |
| Connection pool bounded | ✅ |
| Circuit breaker on the payment provider | ✅ |
| Graceful shutdown drains in-flight requests | ✅ |

## Secrets and supply chain

| Control | Status |
|---|---|
| All secrets via environment, validated at boot | ✅ |
| Minimum lengths enforced so placeholders cannot reach production | ✅ |
| `.env` git-ignored; `.env.example` carries no real values | ✅ |
| `.env.test` contains throwaway values only, committed intentionally | ✅ |
| `npm ci` from a committed lockfile | ✅ |
| `npm audit --omit=dev --audit-level=high` gates CI | ✅ |
| Trivy scans the built image (HIGH/CRITICAL fail) | ✅ |
| gitleaks over full history | ✅ |
| CodeQL static analysis | ✅ |
| Container runs as non-root with tini as PID 1 | ✅ |
| Multi-stage build — no dev dependencies or source in the runtime image | ✅ |

## Pre-deploy verification

- [ ] `JWT_SECRET`, `DATA_MASTER_KEY`, `IP_HASH_SALT` generated fresh, never copied from `.env.example`
- [ ] `DATA_MASTER_KEY` decodes to exactly 32 bytes
- [ ] `CORS_ORIGINS` lists real frontend origins only — no wildcard
- [ ] `DATABASE_SSL=true` and `sslmode=require` against a managed database
- [ ] `/metrics` not reachable from the public ingress
- [ ] Database and Redis have no public IP
- [ ] At least one admin account exists with MFA enrolled
- [ ] Backups verified by an actual restore, not by the presence of a snapshot
- [ ] Alert routing tested end to end with a deliberately fired alert
