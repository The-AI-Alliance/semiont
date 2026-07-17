/**
 * Bounded inference calls (WORKER-LIVENESS.md P2).
 *
 * The claim loop's only unbounded await was the model call: one HTTP
 * request that never settles used to wedge the worker forever (the
 * adapter ignores announcements while isProcessing). These tests pin
 * the bound: a never-resolving call becomes an ordinary job failure,
 * a fast call passes through untouched, and real model errors are not
 * masked as timeouts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { InferenceClient } from '@semiont/inference';
import {
  boundedGenerate,
  boundedGenerateWithMetadata,
  INFERENCE_TIMEOUT_MS,
} from '../../workers/inference-call';
import { AnnotationDetection } from '../../workers/annotation-detection';

const never = () => new Promise<never>(() => {});

function clientWith(overrides: Partial<InferenceClient>): InferenceClient {
  return {
    type: 'test',
    modelId: 'test-model',
    generateText: vi.fn(async () => 'text'),
    generateTextWithMetadata: vi.fn(async () => ({ text: '[]', stopReason: 'end_turn' })),
    ...overrides,
  } as InferenceClient;
}

describe('bounded inference calls', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes results and arguments through when the model answers in time', async () => {
    const client = clientWith({});

    await expect(boundedGenerate(client, 'p', 100, 0.1)).resolves.toBe('text');
    await expect(
      boundedGenerateWithMetadata(client, 'p', 100, 0.1, { format: 'json' }),
    ).resolves.toEqual({ text: '[]', stopReason: 'end_turn' });

    expect(client.generateText).toHaveBeenCalledWith('p', 100, 0.1, undefined);
    expect(client.generateTextWithMetadata).toHaveBeenCalledWith('p', 100, 0.1, { format: 'json' });
  });

  it('rejects with a timeout error when the model call never resolves', async () => {
    vi.useFakeTimers();
    const client = clientWith({ generateTextWithMetadata: vi.fn(never) });

    const pending = boundedGenerateWithMetadata(client, 'p', 100, 0.1);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT_MS + 1);
    await assertion;
  });

  it('rejects the simple-interface variant on timeout too', async () => {
    vi.useFakeTimers();
    const client = clientWith({ generateText: vi.fn(never) });

    const pending = boundedGenerate(client, 'p', 100, 0.1);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT_MS + 1);
    await assertion;
  });

  it('propagates model errors unchanged — no timeout masking', async () => {
    const client = clientWith({
      generateText: vi.fn(async () => {
        throw new Error('model exploded');
      }),
    });

    await expect(boundedGenerate(client, 'p', 100, 0.1)).rejects.toThrow('model exploded');
  });

  it('detection call sites route through the bound (never-resolving model → timeout, not a wedged worker)', async () => {
    vi.useFakeTimers();
    const client = clientWith({ generateTextWithMetadata: vi.fn(never) });

    const pending = AnnotationDetection.detectHighlights('some content', client);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT_MS + 1);
    await assertion;
  });
});
