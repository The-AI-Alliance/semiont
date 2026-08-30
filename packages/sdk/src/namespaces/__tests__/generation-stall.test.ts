/**
 * FLOW-LIFECYCLE-CONVERGENCE P1 — the ONE stall guard for generation.
 *
 * The guard lives inside `runGeneration`'s producer, so every consumption of
 * the stream — `await`, `.run()`, and the yield state unit's `drive` — shares
 * it (A1). Pins here:
 *  - silence past the deadline → `job:cancel-requested` (jobType generation)
 *    on the wire + a typed `GenerationStallError` (A2)
 *  - an event inside the window resets it; a terminal inside the window never
 *    cancels (A3)
 *  - the deadline derives from `maxTokens` (floor + per-token, ONE site) with
 *    a per-call `stallDeadlineMs` override that NEVER rides the wire (D1a)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { EventBus } from '@semiont/core';
import type { ConnectionState, ITransport, IContentTransport } from '@semiont/core';
import { resourceContextFor } from '../../__tests__/fixtures/gathered-context';
import { YieldNamespace } from '../yield';
import { createYieldStateUnit } from '../../state/flows/yield-state-unit';
import type { SemiontClient } from '../../client';
import {
  GenerationStallError,
  deriveStallDeadlineMs,
  GENERATION_STALL_FLOOR_MS,
} from '../generation-stall';

const CTX_RES = resourceContextFor('res-1');

type ResponseMap = Record<string, (payload: Record<string, unknown>) => { resultChannel: string; response: Record<string, unknown> }>;

function createMockTransport(responses: ResponseMap): { transport: ITransport; emitSpy: ReturnType<typeof vi.fn> } {
  const transportBus = new EventBus();
  const emitSpy = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    const handler = responses[channel];
    if (handler) {
      const { resultChannel, response } = handler(payload);
      const correlationId = payload.correlationId as string;
      queueMicrotask(() => {
        (transportBus.get(resultChannel as never) as { next(v: unknown): void }).next({ correlationId, response });
      });
    }
    return 1;
  });
  const transport = {
    emit: emitSpy,
    on: <K extends never>(channel: K, handler: (p: never) => void) => {
      const sub = (transportBus.get(channel) as { subscribe(fn: (p: never) => void): { unsubscribe(): void } }).subscribe(handler);
      return () => sub.unsubscribe();
    },
    stream: <K extends never>(channel: K) => transportBus.get(channel),
    subscribeToResource: vi.fn().mockReturnValue(() => {}),
    bridgeInto: vi.fn(),
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
    dispose: vi.fn(),
  } as unknown as ITransport;
  return { transport, emitSpy };
}

function makeMockContent(): IContentTransport {
  return {
    putBinary: vi.fn(),
    getBinary: vi.fn(),
    getBinaryStream: vi.fn(),
    getResourceGraph: vi.fn(),
    dispose: vi.fn(),
  };
}

function harness() {
  const bus = new EventBus();
  const { transport, emitSpy } = createMockTransport({
    'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
    'job:status-requested': () => ({ resultChannel: 'job:status-result', response: { status: 'running' } }),
    'job:cancel-requested': () => ({ resultChannel: 'job:cancel-ok', response: { cancelled: 1 } }),
  });
  const y = new YieldNamespace(transport, bus, makeMockContent());
  return { y, bus, emitSpy };
}

const cancelCount = (spy: ReturnType<typeof vi.fn>): number =>
  spy.mock.calls.filter(([ch]) => ch === 'job:cancel-requested').length;

describe('generation stall guard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the deadline at one site: floor + per-token scaling', () => {
    expect(deriveStallDeadlineMs(undefined)).toBe(GENERATION_STALL_FLOOR_MS); // 500 assumed × 75 < floor
    expect(deriveStallDeadlineMs(100)).toBe(GENERATION_STALL_FLOOR_MS);
    expect(deriveStallDeadlineMs(4000)).toBe(300_000);
    expect(deriveStallDeadlineMs(16_000)).toBe(1_200_000);
  });

  it('silence past the deadline cancels the job and rejects run() with the typed error', async () => {
    vi.useFakeTimers();
    const { y, emitSpy } = harness();

    const p = y.fromContext(CTX_RES, { title: 'T', storageUri: 's', maxTokens: 4000 }).run(() => {});
    const rejection = expect(p).rejects.toBeInstanceOf(GenerationStallError);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(cancelCount(emitSpy)).toBe(0);

    await vi.advanceTimersByTimeAsync(1); // 4000 × 75ms = 300s exactly
    await rejection;
    expect(cancelCount(emitSpy)).toBe(1);
    expect(emitSpy).toHaveBeenCalledWith('job:cancel-requested', expect.objectContaining({ jobType: 'generation' }));
  });

  it('an event inside the window resets it', async () => {
    vi.useFakeTimers();
    const { y, bus, emitSpy } = harness();

    const p = y.fromContext(CTX_RES, { title: 'T', storageUri: 's', maxTokens: 4000 }).run(() => {});
    const rejection = expect(p).rejects.toBeInstanceOf(GenerationStallError);

    await vi.advanceTimersByTimeAsync(299_000);
    bus.get('job:report-progress').next({
      resourceId: 'res-1', jobId: 'j1', jobType: 'generation', percentage: 50,
      progress: { percentage: 50 },
    });

    // 299s after the reset — still inside the new window.
    await vi.advanceTimersByTimeAsync(299_000);
    expect(cancelCount(emitSpy)).toBe(0);

    // 300s after the last event — the guard fires.
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(cancelCount(emitSpy)).toBe(1);
  });

  it('a terminal inside the window never cancels', async () => {
    vi.useFakeTimers();
    const { y, bus, emitSpy } = harness();

    const p = y.fromContext(CTX_RES, { title: 'T', storageUri: 's', maxTokens: 4000 }).run(() => {});
    await vi.advanceTimersByTimeAsync(0); // let job:create settle → jobId assigned

    bus.get('job:complete').next({
      jobId: 'j1',
      jobType: 'generation',
      resourceId: 'res-1',
      result: { kind: 'generation', resourceId: 'res-1', resourceName: 'X', truncated: false },
    });

    await expect(p).resolves.toMatchObject({ kind: 'complete' });
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(cancelCount(emitSpy)).toBe(0);
  });

  it('small runs are guarded at the floor, not per-token', async () => {
    vi.useFakeTimers();
    const { y, emitSpy } = harness();

    const p = y.fromContext(CTX_RES, { title: 'T', storageUri: 's', maxTokens: 100 }).run(() => {});
    const rejection = expect(p).rejects.toBeInstanceOf(GenerationStallError);

    await vi.advanceTimersByTimeAsync(GENERATION_STALL_FLOOR_MS - 1);
    expect(cancelCount(emitSpy)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(cancelCount(emitSpy)).toBe(1);
  });

  it('stallDeadlineMs overrides the derivation and NEVER rides the wire', async () => {
    vi.useFakeTimers();
    const { y, emitSpy } = harness();

    const p = y.fromContext(
      CTX_RES,
      { title: 'T', storageUri: 's', maxTokens: 100_000, stallDeadlineMs: 90_000 },
    ).run(() => {});
    const rejection = expect(p).rejects.toBeInstanceOf(GenerationStallError);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(cancelCount(emitSpy)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(cancelCount(emitSpy)).toBe(1);

    // Wire hygiene (GWC discipline): the client-only knob is stripped before
    // `job:create` — `params` is the WIRE's GenerationJobParams, nothing more.
    const createCall = emitSpy.mock.calls.find(([ch]) => ch === 'job:create')!;
    expect((createCall[1] as { params: Record<string, unknown> }).params).not.toHaveProperty('stallDeadlineMs');
  });

  it("the unit's drive path shares the same guard: stall cancels and clears the display", async () => {
    vi.useFakeTimers();
    const { y, emitSpy } = harness();
    const client = { yield: y } as unknown as SemiontClient;
    const unit = createYieldStateUnit(client, 'en');
    const gen: boolean[] = [];
    const prog: unknown[] = [];
    unit.isGenerating$.subscribe((v) => gen.push(v));
    unit.progress$.subscribe((v) => prog.push(v));

    unit.generate(CTX_RES, { title: 'T', storageUri: 's', maxTokens: 4000 });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(cancelCount(emitSpy)).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancelCount(emitSpy)).toBe(1);
    // The unit surfaces the stall exactly as its old timeout did: display
    // cleared, not generating.
    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).toBeNull();

    unit.dispose();
  });
});
