import { cp, mkdir } from 'node:fs/promises';

// tsc only emits JavaScript, so the .sql migrations would be missing from the
// image and the container would start against an empty schema.
await mkdir('dist/db/migrations', { recursive: true });
await cp('src/db/migrations', 'dist/db/migrations', { recursive: true });

// The OpenAPI document is served at /openapi.json and rendered at /docs, so
// the built image needs its own copy.
await cp('openapi.json', 'dist/openapi.json');

console.log('copied migrations and openapi.json into dist/');
