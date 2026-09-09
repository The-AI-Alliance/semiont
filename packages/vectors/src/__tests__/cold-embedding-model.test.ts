/**
 * A cold embedding-model cache is retryable, not fatal.
 *
 * On the first boot of a fresh KB, the three services that call
 * `createVectorStore` — archivist, librarian, smelter — raced Ollama's
 * `nomic-embed-text` pull and died on its 404. Measured 3/4/5 restarts across two
 * codespaces, and the archivist's flapping is separately what strands
 * `semiont-worker` in `Created` forever. The process was choosing to die over a
 * condition that heals itself in under a minute.
 *
 * Three adjacent decisions on this path are RIGHT and are deliberately untouched
 * — each looks like the bug and is not:
 *   - `ensureCollection` resolves `dimensions()` only when it must CREATE a
 *     collection, so a warm KB never contacts the provider at boot;
 *   - `measureDimensions` probes the model instead of consulting a table;
 *   - `dimensions()` refuses to cache a failure.
 * The gap is narrower than any of them: nothing on the path could CLASSIFY a cold
 * model cache, because the status lived only inside a message string.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaEmbeddingProvider } from '../embedding/ollama';
import { VoyageEmbeddingProvider } from '../embedding/voyage';
import { EmbeddingProviderError, isColdModelError } from '../embedding/provider-error';
import { resolveDimensions } from '../embedding/resolve-dimensions';

afterEach(() => { vi.unstubAllGlobals(); });

const notPulled = () =>
  new Response('{"error":"model \\"nomic-embed-text\\" not found, try pulling it first"}', { status: 404 });
const embedding = (width: number) =>
  new Response(JSON.stringify({ embeddings: [Array(width).fill(0.1)] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

describe('the failure carries its status as structure, not prose', () => {
  it('Ollama embed() rejects with a typed error exposing status and body', async () => {
    // The whole reason the condition was unclassifiable: `throw new Error(
    // \`Ollama embed error ${status}: ${body}\`)` put the status in the text and
    // nowhere else, so any caller wanting to branch had to match a substring —
    // the mirror this codebase refuses elsewhere.
    vi.stubGlobal('fetch', vi.fn(async () => notPulled()));
    const provider = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });

    await expect(provider.embed('x')).rejects.toMatchObject({
      name: 'EmbeddingProviderError',
      status: 404,
      provider: 'ollama',
      model: 'nomic-embed-text',
    });
  });

  it('Voyage gets the same treatment, so the two agree by construction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const provider = new VoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-3' });

    await expect(provider.embed('x')).rejects.toMatchObject({
      name: 'EmbeddingProviderError',
      status: 404,
      provider: 'voyage',
      // Carried as a field, not recoverable from the body: Voyage's 404 body does
      // not name the model, so a consumer reading the message would work for
      // Ollama and silently fail here.
      model: 'voyage-3',
    });
  });

  it('keeps the status in the message too — the log line stays readable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notPulled()));
    const provider = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    await expect(provider.embed('x')).rejects.toThrow(/404/);
  });
});

describe('isColdModelError', () => {
  it('accepts a 404 from an embedding provider — the model is not pulled YET', () => {
    // The case `isTransientFetchError`'s reasoning did not anticipate. Its
    // exclusion of HTTP-level failures is right for a gateway 401 ("the server is
    // up and rejected us") and wrong here: the server is up, the RESOURCE is not
    // there yet, and it will be.
    expect(isColdModelError(new EmbeddingProviderError('ollama', 404, 'nomic-embed-text', 'model not found'))).toBe(true);
  });

  it('rejects every other status — a retry must not paper over a real refusal', () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      expect(isColdModelError(new EmbeddingProviderError('ollama', status, 'nomic-embed-text', 'x')), String(status)).toBe(false);
    }
  });

  it('rejects a 404 that is not an embedding provider error', () => {
    // Narrow on purpose: a 404 from the gateway means not-found and retrying it
    // is wrong. Only this provider's 404 carries "not yet".
    expect(isColdModelError(Object.assign(new Error('gone'), { status: 404 }))).toBe(false);
    expect(isColdModelError(new Error('Ollama embed error 404: model not found'))).toBe(false);
    expect(isColdModelError(undefined)).toBe(false);
  });
});

describe('dimension discovery survives a cold cache', () => {
  // Fake timers drive the backoff sleeps — they are ordinary `setTimeout`s — so
  // the ~39s STARTUP_FETCH_RETRY budget costs nothing here and needs no
  // test-only parameter widening `resolveDimensions`' signature.
  afterEach(() => { vi.useRealTimers(); });

  it('retries the probe and resolves once the pull lands', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(notPulled())
      .mockResolvedValueOnce(notPulled())
      .mockResolvedValueOnce(embedding(768));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    const resolved = resolveDimensions(() => provider.dimensions());
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(resolved).resolves.toBe(768);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('still fails when the model never arrives, naming BOTH live possibilities', async () => {
    // Bounded by design. A typo'd model name now fails after the policy instead
    // of instantly — the price of not distinguishing "not pulled yet" from "never
    // will be" over one 404. The final message is what makes that price
    // diagnosable: today's text implies only the first possibility.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => notPulled()));

    const provider = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    const rejects = expect(resolveDimensions(() => provider.dimensions()))
      // The model is NAMED, off the error's field. The point of the typed error
      // is that nothing downstream reads a fact out of a message.
      .rejects.toThrow(/'nomic-embed-text'.*not been pulled.*configured model name/is);
    await vi.advanceTimersByTimeAsync(120_000);
    await rejects;
  });

  it('does NOT retry a non-cold failure — fail-fast is preserved', async () => {
    // A retry that never gives up would trade this bug for a worse one, and a
    // 401 from a cloud provider will not become a 200 by waiting.
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new VoyageEmbeddingProvider({ apiKey: 'wrong', model: 'voyage-3' });
    const rejects = expect(resolveDimensions(() => provider.dimensions())).rejects.toThrow(/401/);
    await vi.advanceTimersByTimeAsync(120_000);
    await rejects;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
