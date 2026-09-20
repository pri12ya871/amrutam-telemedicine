import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { stringify } from 'yaml';

import { loginSchema, mfaConfirmSchema, refreshSchema, registerSchema } from '../src/modules/auth/authSchemas.ts';
import { doctorProfileSchema, doctorSearchSchema } from '../src/modules/doctors/doctorService.ts';
import { availabilityRuleSchema, slotQuerySchema } from '../src/modules/availability/availabilityService.ts';
import { cancelBookingSchema, createBookingSchema } from '../src/modules/booking/bookingService.ts';
import { consultationNotesSchema, listConsultationsSchema } from '../src/modules/consultations/consultationService.ts';
import { createPrescriptionSchema } from '../src/modules/prescriptions/prescriptionService.ts';
import { analyticsRangeSchema } from '../src/modules/admin/analyticsService.ts';

extendZodWithOpenApi(z);

/**
 * The OpenAPI document is *generated from the Zod schemas the server actually
 * validates with*, not written by hand alongside them. A hand-written spec
 * starts accurate and drifts; this one cannot disagree with the server,
 * because there is only one definition of each shape.
 */
const registry = new OpenAPIRegistry();

const bearer = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Access token from POST /auth/login. Expires in 15 minutes; rotate with /auth/refresh.',
});

const idempotencyHeader = z.object({
  'Idempotency-Key': z.string().uuid().openapi({
    description:
      'Required. A UUID that is stable across retries of the same logical request. ' +
      'Retrying with the same key replays the original response instead of repeating the write.',
    example: '8f14e45f-ceea-467a-9c2b-1d7a3f0e1a20',
  }),
});

const errorSchema = registry.register(
  'Error',
  z.object({
    error: z.object({
      code: z.string().openapi({ example: 'SLOT_UNAVAILABLE' }),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
    }),
  }),
);

const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ data });

const json = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const errorResponse = (description: string) => json(errorSchema, description);

const tokenPair = registry.register(
  'TokenPair',
  z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.string().openapi({ example: '15m' }),
    tokenType: z.literal('Bearer'),
  }),
);

const bookingResult = registry.register(
  'BookingResult',
  z.object({
    consultationId: z.string().uuid(),
    status: z.string().openapi({ example: 'pending_payment' }),
    scheduledAt: z.string().datetime(),
    doctorId: z.string().uuid(),
    holdExpiresAt: z.string().datetime().openapi({
      description: 'The slot is released automatically if payment is not captured before this time.',
    }),
    payment: z.object({
      id: z.string().uuid(),
      amountPaise: z.number().int(),
      currency: z.string(),
      status: z.string(),
    }),
  }),
);

const uuidParam = (name: string) =>
  z.object({ [name]: z.string().uuid() }) as unknown as z.ZodObject<Record<string, z.ZodString>>;

// ------------------------------------------------------------------- auth

registry.registerPath({
  method: 'post', path: '/api/v1/auth/register', tags: ['Auth'],
  summary: 'Register a patient or doctor account',
  description:
    'Admin accounts cannot be self-registered. A doctor account is created unverified and ' +
    'cannot accept bookings until an administrator verifies the medical registration number.',
  request: { body: { content: { 'application/json': { schema: registerSchema } } } },
  responses: {
    201: json(envelope(z.object({ id: z.string().uuid(), email: z.string(), role: z.string() })), 'Account created'),
    400: errorResponse('Validation failed — password policy or malformed input'),
    409: errorResponse('Email already registered'),
    429: errorResponse('Rate limited'),
  },
});

registry.registerPath({
  method: 'post', path: '/api/v1/auth/login', tags: ['Auth'],
  summary: 'Exchange credentials for a token pair',
  description:
    'Returns 401 both for an unknown account and a wrong password, deliberately, so the ' +
    'endpoint cannot be used to enumerate accounts. Five failures lock the account for 15 minutes. ' +
    'If MFA is enabled, `totp` is required.',
  request: { body: { content: { 'application/json': { schema: loginSchema } } } },
  responses: {
    200: json(envelope(tokenPair), 'Authenticated'),
    401: errorResponse('Invalid credentials, or MFA code required/incorrect'),
    403: errorResponse('Account locked or not active'),
  },
});

registry.registerPath({
  method: 'post', path: '/api/v1/auth/refresh', tags: ['Auth'],
  summary: 'Rotate a refresh token',
  description:
    'Single-use. Presenting an already-used token is treated as theft: the entire token ' +
    'family is revoked and every session for that user ends.',
  request: { body: { content: { 'application/json': { schema: refreshSchema } } } },
  responses: {
    200: json(envelope(tokenPair), 'New token pair'),
    401: errorResponse('Invalid, expired, revoked, or reused token'),
  },
});

registry.registerPath({
  method: 'post', path: '/api/v1/auth/logout', tags: ['Auth'],
  summary: 'Revoke a refresh-token family',
  request: { body: { content: { 'application/json': { schema: refreshSchema } } } },
  responses: { 204: { description: 'Logged out (idempotent)' } },
});

registry.registerPath({
  method: 'post', path: '/api/v1/auth/mfa/setup', tags: ['Auth'],
  summary: 'Begin TOTP enrolment', security: [{ [bearer.name]: [] }],
  description: 'Returns a secret and an otpauth:// URI for a QR code. MFA is not active until confirmed.',
  responses: {
    200: json(envelope(z.object({ secret: z.string(), otpauthUri: z.string() })), 'Enrolment started'),
    409: errorResponse('MFA already enabled'),
  },
});

registry.registerPath({
  method: 'post', path: '/api/v1/auth/mfa/confirm', tags: ['Auth'],
  summary: 'Activate TOTP after verifying a code', security: [{ [bearer.name]: [] }],
  request: { body: { content: { 'application/json': { schema: mfaConfirmSchema } } } },
  responses: {
    200: json(envelope(z.object({ mfaEnabled: z.boolean() })), 'MFA enabled'),
    401: errorResponse('Invalid code'),
  },
});

registry.registerPath({
  method: 'get', path: '/api/v1/auth/me', tags: ['Auth'],
  summary: 'Current token identity', security: [{ [bearer.name]: [] }],
  responses: { 200: json(envelope(z.object({ id: z.string(), role: z.string(), mfaSatisfied: z.boolean() })), 'Identity') },
});

// ---------------------------------------------------------------- doctors

registry.registerPath({
  method: 'get', path: '/api/v1/doctors', tags: ['Doctors'],
  summary: 'Search and filter doctors',
  description: 'Public. Results are cached for 60 seconds; only verified, active doctors are returned.',
  request: { query: doctorSearchSchema },
  responses: { 200: json(envelope(z.object({ items: z.array(z.unknown()), total: z.number() })), 'Matching doctors') },
});

registry.registerPath({
  method: 'get', path: '/api/v1/doctors/{id}', tags: ['Doctors'],
  summary: 'Doctor profile', request: { params: uuidParam('id') },
  responses: { 200: json(envelope(z.unknown()), 'Doctor'), 404: errorResponse('Not found') },
});

registry.registerPath({
  method: 'get', path: '/api/v1/doctors/{id}/slots', tags: ['Doctors', 'Availability'],
  summary: 'Bookable slots for a date range',
  description: 'Cached for 30 seconds. A slot listed here can still be taken before you book it — expect 409.',
  request: { params: uuidParam('id'), query: slotQuerySchema },
  responses: { 200: json(envelope(z.array(z.unknown())), 'Available slots') },
});

registry.registerPath({
  method: 'post', path: '/api/v1/doctors/profile', tags: ['Doctors'],
  summary: 'Create the calling doctor\'s profile', security: [{ [bearer.name]: [] }],
  request: { body: { content: { 'application/json': { schema: doctorProfileSchema } } } },
  responses: {
    201: json(envelope(z.object({ id: z.string().uuid(), status: z.string() })), 'Created, pending verification'),
    403: errorResponse('Not a doctor account'),
    409: errorResponse('Profile already exists'),
  },
});

registry.registerPath({
  method: 'post', path: '/api/v1/doctors/me/availability/rules', tags: ['Availability'],
  summary: 'Add a recurring weekly availability rule', security: [{ [bearer.name]: [] }],
  request: { body: { content: { 'application/json': { schema: availabilityRuleSchema } } } },
  responses: { 201: json(envelope(z.object({ id: z.string().uuid() })), 'Rule created') },
});

registry.registerPath({
  method: 'post', path: '/api/v1/doctors/me/availability/generate', tags: ['Availability'],
  summary: 'Materialise slots from rules for a date range', security: [{ [bearer.name]: [] }],
  description: 'Naturally idempotent: re-running over the same window creates no duplicates.',
  request: {
    body: { content: { 'application/json': { schema: z.object({ from: z.string().date(), to: z.string().date() }) } } },
  },
  responses: { 201: json(envelope(z.object({ slotsCreated: z.number() })), 'Slots created') },
});

registry.registerPath({
  method: 'post', path: '/api/v1/doctors/{id}/verify', tags: ['Doctors', 'Admin'],
  summary: 'Verify a doctor (admin, MFA required)', security: [{ [bearer.name]: [] }],
  request: { params: uuidParam('id') },
  responses: {
    200: json(envelope(z.unknown()), 'Verified'),
    401: errorResponse('MFA required'),
    403: errorResponse('Not an administrator'),
  },
});

// --------------------------------------------------------------- bookings

registry.registerPath({
  method: 'post', path: '/api/v1/bookings', tags: ['Bookings'],
  summary: 'Book a slot (idempotent)', security: [{ [bearer.name]: [] }],
  description:
    'Claims the slot atomically and holds it for SLOT_HOLD_MINUTES pending payment. ' +
    'Concurrent requests for the same slot: exactly one receives 201, the rest receive ' +
    '409 SLOT_UNAVAILABLE. Requires an Idempotency-Key.',
  request: {
    headers: idempotencyHeader,
    body: { content: { 'application/json': { schema: createBookingSchema } } },
  },
  responses: {
    201: json(envelope(bookingResult), 'Slot held, payment pending'),
    400: errorResponse('Missing Idempotency-Key, or the slot is in the past'),
    409: errorResponse('SLOT_UNAVAILABLE, or a request with this key is in progress'),
    422: errorResponse('IDEMPOTENCY_KEY_REUSE — same key, different body'),
  },
});

registry.registerPath({
  method: 'post', path: '/api/v1/bookings/{id}/cancel', tags: ['Bookings'],
  summary: 'Cancel and release the slot', security: [{ [bearer.name]: [] }],
  request: {
    params: uuidParam('id'), headers: idempotencyHeader,
    body: { content: { 'application/json': { schema: cancelBookingSchema } } },
  },
  responses: {
    200: json(envelope(z.object({ consultationId: z.string(), status: z.string() })), 'Cancelled'),
    403: errorResponse('Not a participant'),
    409: errorResponse('Already completed or cancelled'),
  },
});

// --------------------------------------------------------------- payments

registry.registerPath({
  method: 'post', path: '/api/v1/payments/{id}/capture', tags: ['Payments'],
  summary: 'Capture a pending payment and confirm the booking (idempotent)',
  security: [{ [bearer.name]: [] }],
  description:
    'Retries are safe: the state transition is guarded in SQL, so a duplicate capture ' +
    'never charges twice. `simulate` exercises the failure paths of the mock provider.',
  request: {
    params: uuidParam('id'), headers: idempotencyHeader,
    body: {
      content: {
        'application/json': { schema: z.object({ simulate: z.enum(['success', 'failure', 'timeout']).default('success') }) },
      },
    },
  },
  responses: {
    200: json(envelope(z.object({ paymentId: z.string(), status: z.string() })), 'Captured'),
    409: errorResponse('PAYMENT_DECLINED or invalid payment state'),
    503: errorResponse('Provider circuit open — slot still held, retry shortly'),
  },
});

// ---------------------------------------------------------- consultations

registry.registerPath({
  method: 'get', path: '/api/v1/consultations', tags: ['Consultations'],
  summary: 'List the caller\'s consultations', security: [{ [bearer.name]: [] }],
  request: { query: listConsultationsSchema },
  responses: { 200: json(envelope(z.object({ items: z.array(z.unknown()) })), 'Consultations') },
});

registry.registerPath({
  method: 'get', path: '/api/v1/consultations/{id}', tags: ['Consultations'],
  summary: 'Consultation detail', security: [{ [bearer.name]: [] }],
  description:
    'Participants only. A non-participant receives 404 rather than 403, so the endpoint ' +
    'cannot confirm that an id exists. Clinical notes are visible to the doctor only.',
  request: { params: uuidParam('id') },
  responses: { 200: json(envelope(z.unknown()), 'Consultation'), 404: errorResponse('Not found or not yours') },
});

registry.registerPath({
  method: 'post', path: '/api/v1/consultations/{id}/status', tags: ['Consultations'],
  summary: 'Advance the consultation state machine', security: [{ [bearer.name]: [] }],
  request: {
    params: uuidParam('id'),
    body: { content: { 'application/json': { schema: z.object({ status: z.enum(['in_progress', 'completed', 'no_show']) }) } } },
  },
  responses: {
    200: json(envelope(z.unknown()), 'Transitioned'),
    409: errorResponse('INVALID_TRANSITION'),
  },
});

registry.registerPath({
  method: 'put', path: '/api/v1/consultations/{id}/notes', tags: ['Consultations'],
  summary: 'Save encrypted clinical notes (doctor only)', security: [{ [bearer.name]: [] }],
  request: {
    params: uuidParam('id'),
    body: { content: { 'application/json': { schema: consultationNotesSchema } } },
  },
  responses: { 204: { description: 'Saved' } },
});

// ----------------------------------------------------------- prescriptions

registry.registerPath({
  method: 'post', path: '/api/v1/prescriptions', tags: ['Prescriptions'],
  summary: 'Issue a prescription (doctor, MFA required, idempotent)',
  security: [{ [bearer.name]: [] }],
  description: 'The clinical payload is envelope-encrypted at rest. Every read is audited.',
  request: {
    headers: idempotencyHeader,
    body: { content: { 'application/json': { schema: createPrescriptionSchema } } },
  },
  responses: {
    201: json(envelope(z.object({ id: z.string().uuid(), issuedAt: z.string() })), 'Issued'),
    401: errorResponse('MFA required'),
    409: errorResponse('Consultation has not started'),
  },
});

registry.registerPath({
  method: 'get', path: '/api/v1/prescriptions', tags: ['Prescriptions'],
  summary: 'List the caller\'s prescriptions (metadata only)', security: [{ [bearer.name]: [] }],
  responses: { 200: json(envelope(z.object({ items: z.array(z.unknown()) })), 'Prescriptions') },
});

registry.registerPath({
  method: 'get', path: '/api/v1/prescriptions/{id}', tags: ['Prescriptions'],
  summary: 'Decrypted prescription', security: [{ [bearer.name]: [] }],
  request: { params: uuidParam('id') },
  responses: { 200: json(envelope(z.unknown()), 'Prescription'), 404: errorResponse('Not found or not yours') },
});

// ------------------------------------------------------------------ admin

registry.registerPath({
  method: 'get', path: '/api/v1/admin/analytics/overview', tags: ['Admin'],
  summary: 'Platform overview (admin, MFA required)', security: [{ [bearer.name]: [] }],
  responses: { 200: json(envelope(z.unknown()), 'Counters') },
});

registry.registerPath({
  method: 'get', path: '/api/v1/admin/analytics/consultations', tags: ['Admin'],
  summary: 'Consultation volume over time', security: [{ [bearer.name]: [] }],
  request: { query: analyticsRangeSchema },
  responses: { 200: json(envelope(z.array(z.unknown())), 'Trend') },
});

registry.registerPath({
  method: 'get', path: '/api/v1/admin/audit-logs', tags: ['Admin'],
  summary: 'Search the audit trail (admin, MFA required)', security: [{ [bearer.name]: [] }],
  description: 'The audit trail is append-only, enforced by a database trigger.',
  responses: { 200: json(envelope(z.array(z.unknown())), 'Audit entries') },
});

// ------------------------------------------------------------ operational

registry.registerPath({
  method: 'get', path: '/health/live', tags: ['Operations'],
  summary: 'Liveness — is the process up?',
  description: 'Touches no dependency. Used as the orchestrator restart signal.',
  responses: { 200: json(z.object({ status: z.string(), uptime: z.number() }), 'Alive') },
});

registry.registerPath({
  method: 'get', path: '/health/ready', tags: ['Operations'],
  summary: 'Readiness — should this instance receive traffic?',
  description:
    'Requires Postgres and applied migrations. Redis being down does NOT make the instance ' +
    'unready: the service degrades to uncached reads and keeps serving correctly.',
  responses: { 200: json(z.unknown(), 'Ready'), 503: json(z.unknown(), 'Not ready') },
});

registry.registerPath({
  method: 'get', path: '/metrics', tags: ['Operations'],
  summary: 'Prometheus metrics',
  description: 'Exposed on the metrics network only in production, never on the public ingress.',
  responses: { 200: { description: 'Prometheus text exposition format' } },
});

// ------------------------------------------------------------------ emit

const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'Amrutam Telemedicine API',
    version: '1.0.0',
    description: [
      'Backend for consultations, doctor availability and prescriptions.',
      '',
      '## Idempotency',
      'Every non-idempotent write requires an `Idempotency-Key` header. Retrying with the',
      'same key replays the original response rather than repeating the side effect. Keys',
      'are scoped per user and expire after 24 hours.',
      '',
      '## Errors',
      'Every error is `{ "error": { "code", "message", "requestId" } }`. Quote `requestId`',
      'in a support request — it correlates the response with logs and traces.',
      '',
      '## Rate limits',
      'Responses carry `RateLimit-Limit` and `RateLimit-Remaining`. Exceeding a limit returns',
      '429 with `Retry-After`.',
    ].join('\n'),
    license: { name: 'MIT' },
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local' },
  ],
  tags: [
    { name: 'Auth', description: 'Registration, login, MFA and token rotation' },
    { name: 'Doctors', description: 'Doctor profiles, search and verification' },
    { name: 'Availability', description: 'Recurring rules and materialised slots' },
    { name: 'Bookings', description: 'Slot claim, hold and cancellation' },
    { name: 'Payments', description: 'Payment capture and the booking saga' },
    { name: 'Consultations', description: 'Consultation lifecycle and clinical notes' },
    { name: 'Prescriptions', description: 'Encrypted prescriptions' },
    { name: 'Admin', description: 'Analytics and audit trail' },
    { name: 'Operations', description: 'Health and metrics' },
  ],
});

writeFileSync('openapi.yaml', stringify(document));
writeFileSync('openapi.json', JSON.stringify(document, null, 2));
console.log(
  `wrote openapi.yaml and openapi.json (${Object.keys(document.paths ?? {}).length} paths)`,
);
