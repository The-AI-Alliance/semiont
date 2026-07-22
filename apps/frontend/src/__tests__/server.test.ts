// @vitest-environment node
/**
 * BROWSER-KB-DISCOVERY L2a — the frontend image serves `/discovery/*`.
 *
 * The static server's SPA fallback must NOT apply to the discovery prefix:
 * served or 404, never index.html — that's what lets consumers distinguish
 * "absent" from a KB list. ETag + no-cache make polling a revalidation
 * round-trip. The traversal probe and the inverse guard (SPA fallback still
 * works everywhere else) pin the carve-out's edges. Fetching
 * `DISCOVERY_URL_PATH` from @semiont/core couples the served prefix +
 * filename to the constant every consumer will use.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DISCOVERY_URL_PATH } from '@semiont/core';
import { createHandler } from '../../server.js';

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('frontend static server — /discovery prefix (L2a)', () => {
  let server: http.Server;
  let port: number;
  let root: string;

  // Raw http.request with an explicit `path` so traversal probes reach the
  // server verbatim (URL parsing would normalize `..` away client-side).
  function get(rawPath: string, headers: Record<string, string> = {}): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: rawPath, method: 'GET', headers },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'semiont-l2a-'));
    const distDir = path.join(root, 'dist');
    const discoveryDir = path.join(root, 'discovery');
    mkdirSync(distDir);
    mkdirSync(discoveryDir);
    writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><h1>spa-shell</h1>');
    writeFileSync(path.join(distDir, 'app.js'), 'console.log("app");');
    // Outside the discovery dir — the traversal probe's target.
    writeFileSync(path.join(root, 'secret.txt'), 'must-not-serve');
    writeFileSync(
      path.join(discoveryDir, 'kbs.json'),
      JSON.stringify({
        version: 1,
        kbs: [{ host: 'localhost', port: 4001, placement: 'local', repo: 'org/kb', did: 'did:web:example', siteName: 'Example KB', managedBy: 'semiont-launcher' }],
      }),
    );

    server = http.createServer(createHandler({ distDir, discoveryDir }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the discovery document at DISCOVERY_URL_PATH as JSON with ETag + no-cache', async () => {
    const res = await get(DISCOVERY_URL_PATH);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.etag).toMatch(/^"[0-9a-f]+"$/);

    const doc = JSON.parse(res.body);
    expect(doc.version).toBe(1);
    expect(doc.kbs).toHaveLength(1);
  });

  it('returns 304 with no body on a matching If-None-Match', async () => {
    const first = await get(DISCOVERY_URL_PATH);
    const res = await get(DISCOVERY_URL_PATH, { 'If-None-Match': first.headers.etag as string });

    expect(res.status).toBe(304);
    expect(res.body).toBe('');
    expect(res.headers.etag).toBe(first.headers.etag);
  });

  it('404s (never the SPA fallback) for an absent discovery file', async () => {
    const res = await get('/discovery/other.json');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).not.toContain('text/html');
    expect(res.body).not.toContain('spa-shell');
  });

  it('404s the bare prefix, with and without a trailing slash', async () => {
    expect((await get('/discovery')).status).toBe(404);
    expect((await get('/discovery/')).status).toBe(404);
  });

  it('404s a traversal probe instead of escaping the mount', async () => {
    const res = await get('/discovery/../secret.txt');

    expect(res.status).toBe(404);
    expect(res.body).not.toContain('must-not-serve');
  });

  it('still falls back to index.html for normal SPA routes (inverse guard)', async () => {
    const res = await get('/know/some/route');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('spa-shell');
  });

  it('still serves static dist assets', async () => {
    const res = await get('/app.js');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
  });
});
