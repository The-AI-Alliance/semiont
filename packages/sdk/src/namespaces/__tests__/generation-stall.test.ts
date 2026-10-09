/**
 * The ONE stall guard for generation.
 *
 * The guard lives inside the delegation's producer (`delegated`), so every consumption of
 * the stream — `await`, `.run()`, and the yield state unit's `drive` — shares
 * it. Pins here:
 *  - silence past the deadline → `job:cancel-requested` (for the stalled
 *    job's `jobId`) on the wire + a typed `GenerationStallError`
 *  - an event inside the window resets it; a terminal inside the window never
 *    cancels
 *  - the deadline derives from `maxTokens` (floor + per-token, ONE site) with
 *    a per-call `stallDeadlineMs` override that NEVER rides the wire
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventBus, GENERATION_STALL_FLOOR_MS, resourceId, jobId } from '@semiont/core';
import type { ITransport, IContentTransport } from '@semiont/core';
import { resourceContextFor } from '../../__tests__/fixtures/gathered-context';
import { YieldNamespace } from '../yield';
import { createYieldStateUnit } from '../../state/flows/yield-state-unit';
import type { SemiontClient } from '../../client';
import { inMemoryTransport } from '../../__tests__/helpers/in-memory-transport';
import { GenerationStallError, deriveStallDeadlineMs } from '../generation-stall';

const CTX_RES = resourceContextFor('res-1');

type ResponseMap = Record<string, (payload: Record<string, unknown>) => { resultChannel: string; response: Record<string, unknown> }>;

function createMockTransport(responses: ResponseMap): { transport: ITransport; emitSpy: ReturnType<typeof vi.fn> } {
  const transportBus = new EventBus();
  const emitSpy = vi.fn().mockImplementation(async (channel: string, payload: Record<string, unknown>, envelope?: { correlationId?: string }) => {
    const handler = responses[channel];
    if (handler) {
      const { resultChannel, response } = handler(payload);
      const correlationId = envelope?.correlationId as string;
      queueMicrotask(() => {
        transportBus.emit(resultChannel as never, { response } as never, { correlationId });
      });
    }
    return 1;
  });
  const subscribeToResource = vi.fn().mockReturnValue(() => {});
  const transport = inMemoryTransport({
    bus: transportBus,
    subscribeToResource,
    onEmit: (channel, payload, envelope) => {
      void emitSpy(channel, payload, envelope);
    },
  });
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
    'job:cancel-requested': () => ({ resultChannel: 'job:cancel-ok', response: { cancelled: true } }),
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

    const p = y.delegate({ title: 'T', storageUri: 's', maxTokens: 4000, context: CTX_RES }).run(() => {});
    const rejection = expect(p).rejects.toBeInstanceOf(GenerationStallError);
    // The code every SDK reports for a stalled job.
    const coded = expect(p).rejects.toMatchObject({ code: 'job.stalled' });

    await vi.advanceTimersByTimeAsync(299_999);
    expect(cancelCount(emitSpy)).toBe(0);

    await vi.advanceTimersByTimeAsync(1); // 4000 × 75ms = 300s exactly
    await rejection;
    await coded;
    expect(cancelCount(emitSpy)).toBe(1);
    // The job that stalled, by its id: no other generation is touched.
    expect(emitSpy).toHaveBeenCalledWith('job:cancel-requested', { jobId: 'j1' }, expect.objectContaining({ correlationId: expect.any(String) }));
  });

  it('an event inside the window resets it', async () => {
    vi.useFakeTimers();
    const { y, bus, emitSpy } = harness();

    const p = y.delegate({ title: 'T', storageUri: 's', maxTokens: 4000, context: CTX_RES }).run(() => {});
    const rejection = expect(p).rejects.toBeInstanceOf(GenerationStallError);

    await vi.advanceTimersByTimeAsync(299_000);
    bus.emit('job:report-progress', {
      resourceId: resourceId('res-1'), jobId: jobId('j1'), jobType: 'yield', percentage: 50,
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

  it('a generation that stalls before its job is known has nothing to cancel', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    // The knowledge base never answers the job's creation.
    const { transport, emitSpy } = createMockTransport({});
    const y = new YieldNamespace(transport, bus, makeMockContent());

    const p = y.delegate({ title: 'T', storageUri: 's', context: CTX_RES }, 5_000).run(() => {});
    const rejection = expect(p).rejects.toMatchObject({ code: 'job.stalled' });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;

    expect(cancelCount(emitSpy)).toBe(0);
  });

  it('a status of cancelled ends the follower as a cancelled job', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const { transport } = createMockTransport({
      'job:create': () => ({ resultChannel: 'job:created', response: { jobId: 'j1' } }),
      'job:status-requested': () => ({ resultChannel: 'job:status-result', response: { jobId: 'j1', status: 'cancelled' } }),
    });
    const y = new YieldNamespace(transport, bus, makeMockContent());

    const p = y.delegate({ title: 'T', storageUri: 's', maxTokens: 4000, context: CTX_RES }).run(() => {});
    const rejection = expect(p).rejects.toMatchObject({ name: 'JobCancelledError', code: 'job.cancelled', message: 'The job was cancelled', jobId: 'j1' });
    await vi.advanceTimersByTimeAsync(16_000);
    await rejection;
  });

  const statusCount = (spy: ReturnType<typeof vi.fn>): number =>
    spy.mock.calls.filter(([ch]) => ch === 'job:status-requested').length;

  it('a setback is reported and followed past: it is not the end, and the attempt after it is still this job', async () => {
    vi.useFakeTimers();
    const { y, bus } = harness();
    const seen: string[] = [];

    const done = y.delegate({ title: 'T', storageUri: 's', maxTokens: 4000, context: CTX_RES }).run((e) => {
      seen.push(e.kind === 'failed' ? `failed ${e.data.error}` : e.kind);
    });
    await vi.advanceTimersByTimeAsync(10);

    bus.emit('job:fail', { resourceId: resourceId('res-1'), jobId: jobId('j1'), jobType: 'yield', error: 'a blip', willRetry: true });
    bus.emit('job:report-progress', {
      resourceId: resourceId('res-1'), jobId: jobId('j1'), jobType: 'yield', percentage: 50, progress: { percentage: 50 },
    });
    bus.emit('job:complete', { resourceId: resourceId('res-1'), jobId: jobId('j1'), jobType: 'yield' });

    await expect(done).resolves.toEqual({ resourceId: 'res-1', jobId: 'j1', jobType: 'yield' });
    expect(seen).toEqual(['created', 'failed a blip', 'progress', 'complete']);
  });

  it('a setback starts the stall deadline again, and the attempt that died is not asked about', async () => {
    vi.useFakeTimers();
    const { y, bus, emitSpy } = harness();

    const p = y.delegate({ title: 'T', storageUri: 's', maxTokens: 4000, context: CTX_RES }).run(() => {});
    const rejection = expect(p).rejects.toMatchObject({ code: 'job.stalled' });

    await vi.advanceTimersByTimeAsync(299_000);
    const asked = statusCount(emitSpy);
    bus.emit('job:fail', { resourceId: resourceId('res-1'), jobId: jobId('j1'), jobType: 'yield', error: 'a blip', willRetry: true });

    // 299s after the setback: past where the deadline would have fallen had
    // the setback not been heard. The attempt that is coming has its whole
    // deadline, and nobody asks after the one that died.
    await vi.advanceTimersByTimeAsync(299_000);
    expect(cancelCount(emitSpy)).toBe(0);
    expect(statusCount(emitSpy)).toBe(asked);

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(cancelCount(emitSpy)).toBe(1);
  });

  it('a failure that is final, or that does not say, ends the job as failed', async () => {
    for (const said of [{ willRetry: false }, {}]) {
      const { y, bus } = harness();
      const p = y.delegate({ title: 'T', storageUri: 's', maxTokens: 4000, context: CTX_RES }).run(() => {});
      const rejection = expect(p).rejects.toMatchObject({ code: 'job.failed', message: 'the budget is spent' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      bus.emit('job:fail', { resourceId: resourceId('res-1'), jobId: jobId('j1'), jobType: 'yield', error: 'the budget is spent', ...said });
      await rejection;
    }
  });

  it('a terminal inside the window never cancels', async () => {
    vi.useFakeTimers();
    const { y, bus, emitSpy } = harness();

    const p = y.delegate({ title: 'T', storageUri: 's', maxTokens: 4000, context: CTX_RES }).run(() => {});
    await vi.advanceTimersByTimeAsync(0); // let job:create settle → jobId assigned

    bus.emit('job:complete', {
      jobId: jobId('j1'),
      jobType: 'yield',
      resourceId: resourceId('res-1'),
      result: { resourceId: resourceId('res-1'), resourceName: 'X', truncated: false },
    });

    await expect(p).resolves.toMatchObject({ jobId: 'j1', result: { resourceName: 'X' } });
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(cancelCount(emitSpy)).toBe(0);
  });

  it('small runs are guarded at the floor, not per-token', async () => {
    vi.useFakeTimers();
    const { y, emitSpy } = harness();

    const p = y.delegate({ title: 'T', storageUri: 's', maxTokens: 100, context: CTX_RES }).run(() => {});
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

    const p = y.delegate(
      { title: 'T', storageUri: 's', maxTokens: 100_000, context: CTX_RES },
      90_000,
    ).run(() => {});
    const rejection = expect(p).rejects.toBeInstanceOf(GenerationStallError);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(cancelCount(emitSpy)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(cancelCount(emitSpy)).toBe(1);

    // Wire hygiene: the deadline is the follower's own, given beside the
    // job's params and never sent — `params` is the WIRE's
    // GenerationJobParams, nothing more.
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

    unit.generate({ title: 'T', storageUri: 's', maxTokens: 4000, context: CTX_RES });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(cancelCount(emitSpy)).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancelCount(emitSpy)).toBe(1);
    // The unit surfaces the stall: display cleared, not generating.
    expect(gen[gen.length - 1]).toBe(false);
    expect(prog[prog.length - 1]).toBeNull();

    unit.dispose();
  });
});
