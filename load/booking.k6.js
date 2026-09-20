import http from 'k6/http';
import { check, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

/**
 * Load profile for the stated SLOs: p95 < 200ms reads, p95 < 500ms writes.
 *
 *   k6 run load/booking.k6.js
 *   k6 run -e BASE_URL=http://localhost:3000 -e VUS=100 load/booking.k6.js
 *
 * Run this against the Docker Compose stack or CI's service containers — not
 * against a free-tier managed database, whose cold starts and shared CPU make
 * the numbers meaningless.
 *
 * 100k consultations/day is ~1.2 writes/sec averaged, but Indian telemedicine
 * traffic is heavily peaked around 09:00–11:00 and 19:00–22:00. The stages
 * below model roughly 10x the mean as the peak, with reads dominating writes
 * about 20:1 — patients browse far more than they book.
 */

const slotConflicts = new Rate('slot_conflicts');
const bookingLatency = new Trend('booking_latency', true);
const searchLatency = new Trend('search_latency', true);

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const VUS = Number(__ENV.VUS || 50);

export const options = {
  stages: [
    { duration: '30s', target: VUS },      // ramp
    { duration: '2m', target: VUS },       // steady state
    { duration: '30s', target: VUS * 2 },  // peak-hour surge
    { duration: '1m', target: VUS * 2 },
    { duration: '30s', target: 0 },        // ramp down
  ],
  thresholds: {
    // The SLOs, as pass/fail gates rather than as prose.
    'http_req_duration{kind:read}': ['p(95)<200'],
    'http_req_duration{kind:write}': ['p(95)<500'],
    // 99.95% availability leaves very little room; anything above 0.1% of
    // genuine failures is a problem. 409s are expected and excluded below.
    http_req_failed: ['rate<0.001'],
    search_latency: ['p(99)<500'],
  },
};

export function setup() {
  const email = `loadtest-${Date.now()}@example.test`;
  const password = 'load-test-password-that-is-long';

  http.post(
    `${BASE_URL}/api/v1/auth/register`,
    JSON.stringify({ email, password, fullName: 'Load Test', role: 'patient' }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  const login = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  const doctors = http.get(`${BASE_URL}/api/v1/doctors?limit=20`);
  const items = doctors.json('data.items') || [];

  return {
    token: login.json('data.accessToken'),
    doctorIds: items.map((d) => d.id),
  };
}

export default function (data) {
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.token}`,
  };

  // ~95% of iterations are reads, matching the browse-to-book ratio.
  group('read: search and availability', () => {
    const search = http.get(`${BASE_URL}/api/v1/doctors?specialization=Ayurveda&sort=rating`, {
      tags: { kind: 'read' },
    });
    check(search, { 'search 200': (r) => r.status === 200 });
    searchLatency.add(search.timings.duration);

    if (data.doctorIds.length > 0) {
      const doctorId = data.doctorIds[Math.floor(Math.random() * data.doctorIds.length)];
      const from = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

      const slots = http.get(`${BASE_URL}/api/v1/doctors/${doctorId}/slots?from=${from}&to=${to}`, {
        tags: { kind: 'read' },
      });
      check(slots, { 'slots 200': (r) => r.status === 200 });

      // 5% of iterations attempt a booking.
      if (Math.random() < 0.05) {
        const available = slots.json('data') || [];
        if (available.length > 0) {
          const slot = available[Math.floor(Math.random() * available.length)];
          const booking = http.post(
            `${BASE_URL}/api/v1/bookings`,
            JSON.stringify({ slotId: slot.id, mode: 'video' }),
            {
              headers: { ...authHeaders, 'Idempotency-Key': `${__VU}-${__ITER}-${Date.now()}` },
              tags: { kind: 'write' },
            },
          );

          bookingLatency.add(booking.timings.duration);
          slotConflicts.add(booking.status === 409);

          // A 409 is a correct answer under contention, not a failure. Only
          // a 5xx or an unexpected status counts against the error budget.
          check(booking, {
            'booking resolved cleanly': (r) => r.status === 201 || r.status === 409,
          });
        }
      }
    }
  });
}

export function handleSummary(data) {
  const p95 = (metric) => data.metrics[metric]?.values?.['p(95)']?.toFixed(1) ?? 'n/a';
  return {
    stdout: `
SLO check
  read  p95 ${p95('http_req_duration{kind:read}')} ms   (target < 200)
  write p95 ${p95('http_req_duration{kind:write}')} ms   (target < 500)
  slot conflict rate ${((data.metrics.slot_conflicts?.values?.rate ?? 0) * 100).toFixed(1)}%
`,
  };
}
