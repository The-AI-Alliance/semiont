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
import type { InferenceClient, StructuredResponse } from '@semiont/inference';

// Observe span creation without losing the real module: `withSpan` is
// replaced by a pass-through recorder, everything else stays genuine.
const { withSpanMock } = vi.hoisted(() => ({
  withSpanMock: vi.fn((
    _name: string,
    work: (span?: unknown) => unknown,
    _options?: { attrs?: Record<string, unknown> },
  ) => work()),
}));
vi.mock('@semiont/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@semiont/observability')>()),
  withSpan: withSpanMock,
}));
import {
  boundedGenerateStructured,
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
    generateStructured: vi.fn(async () => ({ items: [], stopReason: 'end_turn' })),
    // Resolves immediately (no timer involvement) so detection call sites get
    // past budget derivation to the model call under test.
    limits: vi.fn(async () => ({ contextTokens: 1_000_000, maxOutputTokens: 1_000_000 })),
    ...overrides,
  } as InferenceClient;
}

describe('bounded inference calls', () => {
  afterEach(() => {
    vi.useRealTimers();
    withSpanMock.mockClear();
  });

  it('passes results and arguments through when the model answers in time', async () => {
    const client = clientWith({});
    const ELEMENT = { type: 'object' };

    await expect(
      boundedGenerateWithMetadata(client, 'p', 100, 0.1),
    ).resolves.toEqual({ text: '[]', stopReason: 'end_turn' });
    await expect(
      boundedGenerateStructured(client, 'p', 100, 0.1, ELEMENT),
    ).resolves.toEqual({ items: [], stopReason: 'end_turn' });

    expect(client.generateTextWithMetadata).toHaveBeenCalledWith('p', 100, 0.1);
    expect(client.generateStructured).toHaveBeenCalledWith('p', 100, 0.1, ELEMENT);
  });

  it('rejects with a timeout error when the model call never resolves', async () => {
    vi.useFakeTimers();
    const client = clientWith({ generateTextWithMetadata: vi.fn(never) });

    const pending = boundedGenerateWithMetadata(client, 'p', 100, 0.1);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT_MS + 1);
    await assertion;
  });

  it('propagates model errors unchanged — no timeout masking', async () => {
    const client = clientWith({
      generateTextWithMetadata: vi.fn(async () => {
        throw new Error('model exploded');
      }),
    });

    await expect(boundedGenerateWithMetadata(client, 'p', 100, 0.1)).rejects.toThrow('model exploded');
  });

  // DETECTION-HEARTBEAT Phase A: liveness must come from ELAPSED TIME, not
  // from chunk geometry. A single-chunk document (the normal case — the
  // derived input budget is ~935 K tokens) crosses no chunk boundary, so the
  // boundary heartbeat emits nothing for the entire run; the client's
  // inter-emission timeout (180 s) then kills a healthy job. The in-flight
  // call is the only window that knows the truth.
  describe('in-flight heartbeat', () => {
    it('fires repeatedly DURING one long inference call', async () => {
      vi.useFakeTimers();
      const client = clientWith({ generateStructured: vi.fn(never) });
      const beats: number[] = [];

      const pending = boundedGenerateStructured(
        client, 'p', 100, 0.1, { type: 'object' },
        () => beats.push(Date.now()),
      );
      // Swallow the eventual timeout rejection — this test is about the
      // beats emitted before it, not the bound itself.
      pending.catch(() => {});

      // Two minutes of a still-running call: well inside the 10-minute
      // bound, and well past the client's 180 s silence window.
      await vi.advanceTimersByTimeAsync(120_000);

      expect(beats.length).toBeGreaterThanOrEqual(2);
    });

    it('fires no heartbeat for a call that answers within the interval', async () => {
      const client = clientWith({});
      const beats: number[] = [];

      await boundedGenerateStructured(
        client, 'p', 100, 0.1, { type: 'object' },
        () => beats.push(Date.now()),
      );

      // No spurious emissions for the common fast call.
      expect(beats).toHaveLength(0);
    });

    it('stops beating once the call settles', async () => {
      vi.useFakeTimers();
      let settle: (v: StructuredResponse<never>) => void = () => {};
      const client = clientWith({
        generateStructured: vi.fn(() => new Promise<StructuredResponse<never>>((res) => { settle = res; })),
      });
      const beats: number[] = [];

      const pending = boundedGenerateStructured(
        client, 'p', 100, 0.1, { type: 'object' },
        () => beats.push(Date.now()),
      );

      await vi.advanceTimersByTimeAsync(60_000);
      const duringCall = beats.length;
      expect(duringCall).toBeGreaterThan(0);

      settle({ items: [], stopReason: 'end_turn' });
      await pending;

      // The interval must be cleared with the timeout, in the same finally —
      // a leaked timer would beat forever on a completed job.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(beats.length).toBe(duringCall);
    });
  });

  it('a failing progress emit cannot take down the call it reports on', async () => {
    // The heartbeat is a reporter, not a participant. If the bus is down (or
    // any consumer throws), the inference call must still complete — the
    // alternative is losing real work to a failed notification about it.
    vi.useFakeTimers();
    let finish!: (v: StructuredResponse<never>) => void;
    const client = clientWith({
      generateStructured: vi.fn(() => new Promise<StructuredResponse<never>>((res) => { finish = res; })),
    });

    const pending = boundedGenerateStructured(
      client, 'p', 100, 0.1, { type: 'object' },
      () => { throw new Error('bus is down'); },
    );

    // Several beats, each throwing.
    await vi.advanceTimersByTimeAsync(60_000);
    finish({ items: [], stopReason: 'end_turn' });

    await expect(pending).resolves.toEqual({ items: [], stopReason: 'end_turn' });
  });

  describe('tracing', () => {
    // The reported bug's own diagnostic rider: a 411 s detection job was ONE
    // span with no children, so extraction could not be told from inference in
    // a trace. These pin that every provider call is separately visible.
    it('wraps a structured call in its own span, attributed to the provider and model', async () => {
      const client = clientWith({});

      await boundedGenerateStructured(client, 'p', 4242, 0.1, { type: 'object' });

      const call = withSpanMock.mock.calls.find(([name]) => name === 'inference:structured');
      expect(call).toBeDefined();
      expect(call?.[2]).toMatchObject({
        attrs: {
          'inference.provider': 'test',
          'inference.model': 'test-model',
          'inference.max_tokens': 4242,
        },
      });
    });

    it('wraps the free-text calls too, under their own span name', async () => {
      const client = clientWith({});

      await boundedGenerateWithMetadata(client, 'p', 100, 0.1);

      const textSpans = withSpanMock.mock.calls.filter(([name]) => name === 'inference:text');
      expect(textSpans).toHaveLength(1);
    });

    it('the span wraps the whole call — a failure is recorded inside it, not outside', async () => {
      // withSpan marks the span errored on a throw; that only works if the
      // throw happens INSIDE the wrapped work.
      const client = clientWith({
        generateTextWithMetadata: vi.fn(async () => { throw new Error('model exploded'); }),
      });

      await expect(boundedGenerateWithMetadata(client, 'p', 100, 0.1)).rejects.toThrow('model exploded');

      // The work function the span received is the one that threw.
      const call = withSpanMock.mock.calls.find(([name]) => name === 'inference:text');
      expect(call).toBeDefined();
      await expect((call![1] as () => Promise<unknown>)()).rejects.toThrow('model exploded');
    });
  });

  it('detection call sites route through the bound (never-resolving model → timeout, not a wedged worker)', async () => {
    vi.useFakeTimers();
    const client = clientWith({ generateStructured: vi.fn(never) });

    const pending = AnnotationDetection.detectHighlights('some content', client);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT_MS + 1);
    await assertion;
  });
});
