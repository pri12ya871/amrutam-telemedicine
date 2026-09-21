import { Router } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The generated OpenAPI document lives at the repository root in development
 * (src/../openapi.json) and is copied beside the compiled code for the image
 * (dist/openapi.json). Loaded once at startup, not per request.
 */
function loadSpec(): unknown | null {
  for (const candidate of [join(here, '..', 'openapi.json'), join(here, 'openapi.json')]) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'));
  }
  return null;
}

// Pinned, so the docs page cannot change underneath the service.
const SWAGGER_UI = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14';

/**
 * Service index, the OpenAPI document, and interactive docs.
 *
 * This is an API, so the root used to be a bare 404. Anyone who clones the
 * repository and opens it in a browser should land somewhere that tells them
 * what they are looking at and where to go next.
 */
export function docsRoutes(): Router {
  const router = Router();
  const spec = loadSpec();

  router.get('/', (_req, res) => {
    res.json({
      service: 'amrutam-telemedicine',
      description: 'Telemedicine backend: auth, availability, booking, consultations, prescriptions.',
      links: {
        docs: '/docs',
        openapi: '/openapi.json',
        api: '/api/v1',
        liveness: '/health/live',
        readiness: '/health/ready',
        metrics: '/metrics',
        source: 'https://github.com/pri12ya871/amrutam-telemedicine',
      },
    });
  });

  router.get('/openapi.json', (_req, res) => {
    if (!spec) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'OpenAPI document not built' } });
      return;
    }
    res.json(spec);
  });

  router.get('/docs', (_req, res) => {
    // The global policy is `default-src 'none'`, which is right for JSON and
    // would stop this page loading anything at all. This page gets its own
    // policy, still strict: scripts only from the pinned CDN or carrying this
    // response's nonce, and requests only back to this origin.
    const nonce = randomBytes(16).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
        "style-src 'unsafe-inline' https://cdn.jsdelivr.net",
        "img-src 'self' data: https://cdn.jsdelivr.net",
        "font-src https://cdn.jsdelivr.net data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
    );
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Amrutam Telemedicine API</title>
  <link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css">
</head>
<body>
  <div id="docs"></div>
  <script nonce="${nonce}" src="${SWAGGER_UI}/swagger-ui-bundle.js"></script>
  <script nonce="${nonce}">
    SwaggerUIBundle({ url: '/openapi.json', dom_id: '#docs', deepLinking: true });
  </script>
</body>
</html>`);
  });

  return router;
}
