/**
 * Dimension discovery — the provider itself is the authority.
 *
 * Dimensionality is intrinsic to the embedding model, so it is measured by
 * embedding a probe string, never looked up in a hand-maintained table. An
 * unknown model must yield the measured width or a loud failure — silently
 * inventing 768/1024 creates a qdrant collection at the wrong width and the
 * damage surfaces far from the cause.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { OllamaEmbeddingProvider } from '../embedding/ollama';
import { VoyageEmbeddingProvider } from '../embedding/voyage';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ollamaFetch(width: number) {
  return vi.fn(async () => jsonResponse({ embeddings: [Array(width).fill(0.1)] }));
}

function voyageFetch(width: number) {
  return vi.fn(async () => jsonResponse({ data: [{ embedding: Array(width).fill(0.1) }] }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OllamaEmbeddingProvider dimension discovery', () => {
  it('measures an unknown model by probing — never a silent 768', async () => {
    vi.stubGlobal('fetch', ollamaFetch(7));
    const provider = new OllamaEmbeddingProvider({ model: 'some-brand-new-model' });
    expect(await provider.dimensions()).toBe(7);
  });

  it('measures a formerly-tabled model too — the probe outranks any constant', async () => {
    vi.stubGlobal('fetch', ollamaFetch(3));
    const provider = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    expect(await provider.dimensions()).toBe(3);
  });

  it('probes once per instance — concurrent and repeat calls share one discovery', async () => {
    const fetchMock = ollamaFetch(7);
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaEmbeddingProvider({ model: 'some-brand-new-model' });
    const [a, b] = await Promise.all([provider.dimensions(), provider.dimensions()]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(await provider.dimensions()).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never caches a failed discovery — a later call retries', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockImplementation(async () => jsonResponse({ embeddings: [Array(7).fill(0.1)] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaEmbeddingProvider({ model: 'some-brand-new-model' });
    await expect(provider.dimensions()).rejects.toThrow('connection refused');
    expect(await provider.dimensions()).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails loudly when the probe returns no embedding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ embeddings: [] })));
    const provider = new OllamaEmbeddingProvider({ model: 'some-brand-new-model' });
    await expect(provider.dimensions()).rejects.toThrow(/some-brand-new-model/);
  });
});

describe('VoyageEmbeddingProvider dimension discovery', () => {
  it('measures an unknown model by probing — never a silent 1024', async () => {
    vi.stubGlobal('fetch', voyageFetch(7));
    const provider = new VoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-99' });
    expect(await provider.dimensions()).toBe(7);
  });

  it('measures a formerly-tabled model too — the probe outranks any constant', async () => {
    vi.stubGlobal('fetch', voyageFetch(3));
    const provider = new VoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-3' });
    expect(await provider.dimensions()).toBe(3);
  });

  it('probes once per instance — concurrent and repeat calls share one discovery', async () => {
    const fetchMock = voyageFetch(7);
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-99' });
    const [a, b] = await Promise.all([provider.dimensions(), provider.dimensions()]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(await provider.dimensions()).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never caches a failed discovery — a later call retries', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 rate limited'))
      .mockImplementation(async () => jsonResponse({ data: [{ embedding: Array(7).fill(0.1) }] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-99' });
    await expect(provider.dimensions()).rejects.toThrow('429 rate limited');
    expect(await provider.dimensions()).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails loudly when the probe returns no embedding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [] })));
    const provider = new VoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-99' });
    await expect(provider.dimensions()).rejects.toThrow(/voyage-99/);
  });
});
