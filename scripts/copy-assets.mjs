import { cp, mkdir } from 'node:fs/promises';

// tsc only emits JavaScript, so the .sql migrations would be missing from the
// image and the container would start against an empty schema.
await mkdir('dist/db/migrations', { recursive: true });
await cp('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('copied migrations into dist/');
