import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.ts';
import { closePool } from '../../src/db/pool.ts';

/**
 * The service index and docs need no database, so they are covered here with
 * the unit tests rather than waiting for CI's Postgres.
 */
describe('service index and docs', () => {
  const app = createApp();

  after(async () => {
    await closePool();
  });

  it('describes the service at the root instead of returning 404', async () => {
    const res = await request(app).get('/').expect(200);
    assert.equal(res.body.service, 'amrutam-telemedicine');
    assert.equal(res.body.links.docs, '/docs');
    assert.equal(res.body.links.openapi, '/openapi.json');
  });

  it('serves the generated OpenAPI document', async () => {
    const res = await request(app).get('/openapi.json').expect(200);
    assert.equal(res.body.openapi, '3.1.0');
    assert.ok(res.body.paths['/api/v1/bookings'], 'booking path missing from the spec');
  });

  it('serves the docs page with a nonce-based CSP, not the API\'s blanket deny', async () => {
    const res = await request(app).get('/docs').expect(200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);

    const csp = res.headers['content-security-policy'] as string;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, 'docs CSP must carry a script nonce');
    // Every script tag on the page must carry that exact nonce, or the
    // browser refuses to run it and the page renders blank.
    const scriptTags = res.text.match(/<script[^>]*>/g) ?? [];
    assert.ok(scriptTags.length > 0);
    for (const tag of scriptTags) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
    assert.ok(!csp.includes("'unsafe-eval'"));
  });

  it('keeps the strict policy on everything else', async () => {
    const res = await request(app).get('/health/live').expect(200);
    assert.match(res.headers['content-security-policy'] as string, /default-src 'none'/);
  });

  it('still returns the JSON 404 for routes that genuinely do not exist', async () => {
    const res = await request(app).get('/definitely-not-a-route').expect(404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
