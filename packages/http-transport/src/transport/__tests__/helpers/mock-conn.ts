/**
 * Shared SSE/fetch mocking harness for the actor-state-unit suites.
 *
 * Extracted verbatim from `actor-state-unit.test.ts` so the liveness
 * property suite (`actor-liveness.property.test.ts`, LIVENESS-AXIOMS.md P3)
 * can drive the same connection mechanics without duplicating them.
 *
 * Importing this module stubs the global `fetch` with `mockFetch`. vitest
 * isolates the module registry per test file, so each suite gets its own
 * `mockFetch` instance; reset it in your `beforeEach` (`mockReset()` — the
 * `*Once` queues survive `clearAllMocks`).
 */
import { vi } from 'vitest';

export const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

export function sseChunk(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

export function sseChunkId(event: string, data: string, id: string): string {
  return `event: ${event}\nid: ${id}\ndata: ${data}\n\n`;
}

export function createSSEStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  return {
    stream,
    // Swallow enqueue/close after the stream has errored or closed. Aborting a
    // connection errors its stream; a test may still try to push to the now-
    // retired connection, and that should be a no-op rather than a throw.
    push: (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* errored/closed */ } },
    close: () => { try { controller.close(); } catch { /* already errored/closed */ } },
    error: (e: unknown) => { try { controller.error(e); } catch { /* already errored/closed */ } },
  };
}

export function mockSSEResponse() {
  const sse = createSSEStream();
  const response = {
    ok: true,
    status: 200,
    body: sse.stream,
  };
  mockFetch.mockResolvedValueOnce(response);
  return sse;
}

/**
 * A signal-honoring, optionally-deferred SSE connection mock. Unlike
 * `mockSSEResponse` (which ignores the abort signal), this errors its stream
 * when the connection's `AbortController` fires — faithfully reproducing how a
 * real `fetch(url, { signal })` cancels the response body. `defer: true` holds
 * the fetch promise unresolved until `open()` is called, so a test can observe
 * the window where a new connection is connecting-but-not-yet-open (the
 * make-before-break handoff). `aborted` reflects the captured signal.
 */
export function mockConn({ defer = false }: { defer?: boolean } = {}) {
  const sse = createSSEStream();
  let capturedSignal: AbortSignal | undefined;
  let resolveFetch!: (r: unknown) => void;
  const fetchPromise = new Promise((res) => { resolveFetch = res; });
  const response = { ok: true, status: 200, body: sse.stream };
  mockFetch.mockImplementationOnce((_url: string, opts: { signal?: AbortSignal }) => {
    capturedSignal = opts.signal;
    if (capturedSignal) {
      capturedSignal.addEventListener('abort', () =>
        sse.error(new DOMException('Aborted', 'AbortError')),
      );
    }
    if (!defer) resolveFetch(response);
    return fetchPromise;
  });
  return {
    sse,
    open: () => resolveFetch(response),
    get aborted() { return capturedSignal?.aborted ?? false; },
  };
}
