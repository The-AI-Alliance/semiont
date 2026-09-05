/**
 * Transport ceiling (OLLAMA-DETECTION-TESTING P3.5).
 *
 * Node's fetch is undici, and undici kills any request whose response HEADERS
 * have not arrived within its headersTimeout — 300s by default. With
 * `stream: false` Ollama sends no headers until the whole generation
 * finishes, so that default was a hidden 5-minute generation ceiling,
 * surfacing as a retryable-looking `TypeError: fetch failed`.
 *
 * These tests run against a real local server that delays its headers, at
 * test speed: a tiny bounded dispatcher stands in for the 300s default. The
 * first test doubles as the census gate for the one assumption the fix rests
 * on — that built-in fetch honors a per-request dispatcher from the npm
 * `undici` package (a different copy than Node's bundled one). If Node ever
 * stops honoring it, the bounded fetch stops dying and that test fails.
 *
 * What cannot be proven at test speed — that a real >5-minute generation now
 * completes — belongs to the P4 live gate.
 */
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { unboundedTransport } from '../implementations/ollama.js';

// Same declaration-skew bridge as the adapter's own (see ollama.ts): the
// undici@7 Agent is runtime-compatible with built-in fetch, which these very
// tests prove; only the undici-types@8 declaration disagrees.
type FetchDispatcher = NonNullable<RequestInit['dispatcher']>;

function slowHeaderServer(headerDelayMs: number): Promise<{ url: string; server: Server }> {
  return new Promise(resolve => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end('{"ok":true}');
      }, headerDelayMs);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

describe('generate transport vs the undici header timeout', () => {
  it('a bounded dispatcher kills a slow-headers request in the exact production shape (TypeError, UND_ERR_HEADERS_TIMEOUT)', async () => {
    // undici runs transport timeouts on a coarse ~1s timer wheel (measured:
    // a 500ms headersTimeout fires at ~1010ms; sub-second delays never fire
    // at all) — both spans here must be wheel-visible or the timeout
    // silently cannot trigger and this gate stops gating.
    const { url, server } = await slowHeaderServer(2000);
    const bounded = new Agent({ headersTimeout: 500 }) as unknown as FetchDispatcher;
    try {
      const err = await fetch(url, { dispatcher: bounded }).then(
        () => { throw new Error('expected the bounded fetch to die at the header timeout'); },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TypeError);
      expect((err as TypeError).message).toBe('fetch failed');
      // The classifiable truth hides one level down — P2's harness must
      // capture `cause`, not just the TypeError shell.
      expect((err as { cause?: { code?: string } }).cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT');
    } finally {
      await bounded.close();
      server.close();
    }
  });

  it('the adapter transport accepts headers that outlive such a window', async () => {
    const { url, server } = await slowHeaderServer(300);
    try {
      const res = await fetch(url, { dispatcher: unboundedTransport });
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it('the caller AbortSignal still binds through the unbounded transport — one bound, one owner', async () => {
    const { url, server } = await slowHeaderServer(300);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    try {
      await expect(fetch(url, { dispatcher: unboundedTransport, signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      server.close();
    }
  });
});
