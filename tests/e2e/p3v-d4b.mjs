// RED 2 / D4b: concurrent uploads (gateway, noGit) + annotation creates
// (Archivist's git add) — the git single-writer under real contention.
import { SemiontClient, resourceId as rid } from '@semiont/sdk';

const c = await SemiontClient.signInHttp({ baseUrl: 'http://192.168.64.1:4000', email: 'admin@example.com', password: 'password' });
const stamp = Date.now();
const results = { uploads: [], annotations: [], errors: [] };

const uploads = Array.from({ length: 8 }, (_, i) =>
  c.yield.resource({
    name: `d4b-upload-${stamp}-${i}`,
    storageUri: `file://d4b/${stamp}-${i}.txt`,
    file: Buffer.from(`D4b concurrency probe ${i}: the Archivist is the single git writer.`),
    format: 'text/plain',
    language: 'en',
  }).then(r => results.uploads.push(r.resourceId), e => results.errors.push(`upload-${i}: ${e.message}`)));

await Promise.all(uploads);

// Annotations on the first four fresh resources, concurrently — each create is
// an event append + register (the Archivist's git add) racing the next upload wave.
const wave2 = Array.from({ length: 8 }, (_, i) =>
  c.yield.resource({
    name: `d4b-upload2-${stamp}-${i}`,
    storageUri: `file://d4b/${stamp}-w2-${i}.txt`,
    file: Buffer.from(`wave two ${i}`),
    format: 'text/plain',
    language: 'en',
  }).then(r => results.uploads.push(r.resourceId), e => results.errors.push(`w2-${i}: ${e.message}`)));

const annotates = results.uploads.slice(0, 4).map((id, i) =>
  c.mark.annotation({
    motivation: 'highlighting',
    target: { source: id, selector: { type: 'TextPositionSelector', start: 0, end: 4 } },
  }).then(r => results.annotations.push(r.annotationId), e => results.errors.push(`ann-${i}: ${e.message}`)));

await Promise.all([...wave2, ...annotates]);
console.log(JSON.stringify({ uploads: results.uploads.length, annotations: results.annotations.length, errors: results.errors }));
c.dispose(); process.exit(results.errors.length ? 1 : 0);
