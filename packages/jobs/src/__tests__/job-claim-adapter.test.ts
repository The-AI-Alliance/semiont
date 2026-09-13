/**
 * createJobClaimAdapter — unit tests.
 *
 * The adapter takes a shared bus and attaches job-claim behaviour. The fake
 * is built over a REAL `EventBus` rather than a `Map` of `Subject<any>`
 * (WORKER-BUS-TYPED-BY-CHANNEL P2): core's bus is already typed per channel,
 * so the fake needs no cast and cannot be fed a payload production would
 * reject — the old `Subject<any>` map accepted anything, which is how this
 * file's `job:queued` fixtures went years without `userId`. No HTTP or SSE.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom, skip, take } from 'rxjs';
import { createJobClaimAdapter } from '../job-claim-adapter';
import type { WorkerBus } from '@semiont/sdk';
import { EventBus, type ConnectionState, type EventMap } from '@semiont/core';

function fakeBus() {
  const channels = new Set<keyof EventMap>();
  // A correlated union, not `{ channel: keyof EventMap; payload: <union> }`:
  // the latter pairs every channel with every payload, so `.payload.jobId`
  // would not typecheck even for an emit we know is `job:claim`. This shape
  // lets `channel` narrow `payload` — the same correlation the bus itself
  // now carries.
  type Emitted = { [K in keyof EventMap]: { channel: K; payload: EventMap[K] } }[keyof EventMap];
  const emits: Emitted[] = [];
  const eventBus = new EventBus();

  const bus: WorkerBus = {
    addChannels: vi.fn((cs: readonly (keyof EventMap)[]) => {
      cs.forEach((c) => channels.add(c));
    }),
    stream: <K extends keyof EventMap>(channel: K) => eventBus.get(channel).asObservable(),
    // In-process fixture: replies are pushed synchronously onto the bus
    // above, so 'open' is the truth, not a stub (BUS-ATTACH-GATE.md).
    state$: new BehaviorSubject<ConnectionState>('open'),
    emit: vi.fn(async <K extends keyof EventMap>(channel: K, payload: EventMap[K]) => {
      // TypeScript correlates `channel` with `payload` on READ (see
      // `claimAt`) but not on WRITE through a type parameter: while `K` is
      // unresolved it will not accept `{ channel: K; payload: EventMap[K] }`
      // as a member of the mapped union. The pair is correct by
      // construction — they are this call's own two arguments — so this is
      // the harness's single assertion, and it is what buys narrowing at
      // every read site.
      emits.push({ channel, payload } as Emitted);
      return -1;
    }),
  };

  return {
    bus,
    channels,
    pushEvent: <K extends keyof EventMap>(channel: K, payload: EventMap[K]) =>
      eventBus.get(channel).next(payload),
    emits,
    /** The `job:claim` these tests read, narrowed by its channel — no cast. */
    claimAt: (i: number): EventMap['job:claim'] => {
      const e = emits[i];
      if (!e || e.channel !== 'job:claim') {
        throw new Error(`emits[${i}] is ${e ? e.channel : 'missing'}, not job:claim`);
      }
      return e.payload;
    },
  };
}

describe('createJobClaimAdapter', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('ignores job:queued events of the wrong type', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: ['generation'] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'j1', jobType: 'other', resourceId: 'r1', userId: 'did:u1' });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.emits).toEqual([]);
    expect(await firstValueFrom(adapter.isProcessing$)).toBe(false);

    adapter.dispose();
  });

  it('adds job:queued to the shared actor on start()', () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    expect(h.channels.has('job:queued')).toBe(true);
    expect(h.bus.addChannels).toHaveBeenCalledWith(['job:queued']);

    adapter.dispose();
  });

  it('claims matching jobs and emits job:claim with a correlationId', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: ['generation'] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'j1', jobType: 'generation', resourceId: 'r1', userId: 'did:u1' });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.emits).toHaveLength(1);
    expect(h.emits[0]!.channel).toBe('job:claim');
    const payload = h.claimAt(0);
    expect(payload.jobId).toBe('j1');
    expect(typeof payload.correlationId).toBe('string');

    // Simulate successful claim response.
    h.pushEvent('job:claimed', {
      correlationId: payload.correlationId,
      response: { params: { foo: 'bar' }, metadata: { userId: 'u1' } },
    });

    const active = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    expect(active).toMatchObject({ jobId: 'j1', userId: 'u1', params: { foo: 'bar' } });

    adapter.dispose();
  });

  it('returns isProcessing$ to false when claim fails', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'j2', jobType: 'generation', resourceId: 'r1', userId: 'did:u1' });
    await new Promise((r) => setTimeout(r, 0));

    const corrId = h.claimAt(0).correlationId;
    h.pushEvent('job:claim-failed', { correlationId: corrId, message: 'claim lost' });

    await new Promise((r) => setTimeout(r, 10));
    expect(await firstValueFrom(adapter.isProcessing$)).toBe(false);

    adapter.dispose();
  });

  it('completeJob increments jobsCompleted$ and clears activeJob$', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'j3', jobType: 'generation', resourceId: 'r1', userId: 'did:u1' });
    await new Promise((r) => setTimeout(r, 0));
    h.pushEvent('job:claimed', {
      correlationId: h.claimAt(0).correlationId,
      response: { params: {}, metadata: { userId: 'u' } },
    });
    await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));

    adapter.completeJob();

    expect(await firstValueFrom(adapter.activeJob$)).toBeNull();
    expect(await firstValueFrom(adapter.jobsCompleted$)).toBe(1);

    adapter.dispose();
  });

  it('failJob emits on errors$ and clears activeJob$', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    const errorPromise = firstValueFrom(adapter.errors$);

    adapter.failJob('j5', 'kaboom');
    const err = await errorPromise;
    expect(err).toEqual({ jobId: 'j5', error: 'kaboom' });

    adapter.dispose();
  });

  it('start() is idempotent', () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();
    adapter.start();
    expect(h.bus.addChannels).toHaveBeenCalledTimes(1);

    adapter.dispose();
  });

  it('dispose completes all observables', () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });

    const flags = { active: false, proc: false, done: false, errs: false };
    adapter.activeJob$.subscribe({ complete: () => { flags.active = true; } });
    adapter.isProcessing$.subscribe({ complete: () => { flags.proc = true; } });
    adapter.jobsCompleted$.subscribe({ complete: () => { flags.done = true; } });
    adapter.errors$.subscribe({ complete: () => { flags.errs = true; } });

    adapter.dispose();
    expect(flags).toEqual({ active: true, proc: true, done: true, errs: true });
  });

  // ── Vitals (WORKER-LIVENESS.md P1) ─────────────────────────────────
  // The adapter is the only component that sees every announcement,
  // claim, and finish — its snapshot is what /health and the stall
  // watchdog read.

  describe('vitals', () => {
    it('starts empty', () => {
      const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });

      expect(adapter.vitals()).toEqual({
        lastQueuedEventAt: null,
        lastClaimAt: null,
        lastFinishedAt: null,
        lastActivityAt: null,
        activeJob: null,
        jobsCompleted: 0,
      });

      adapter.dispose();
    });

    it('records the claim → activity → completion cycle', async () => {
      const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
      adapter.start();

      h.pushEvent('job:queued', { jobId: 'jv1', jobType: 'generation', resourceId: 'r1', userId: 'did:u1' });
      await new Promise((r) => setTimeout(r, 0));
      h.pushEvent('job:claimed', {
        correlationId: h.claimAt(0).correlationId,
        response: { params: {}, metadata: { userId: 'u' } },
      });
      await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));

      const claimed = adapter.vitals();
      expect(claimed.lastQueuedEventAt).not.toBeNull();
      expect(claimed.lastClaimAt).not.toBeNull();
      expect(claimed.lastActivityAt).not.toBeNull();
      expect(claimed.activeJob).toMatchObject({ jobId: 'jv1', type: 'generation' });
      expect(typeof claimed.activeJob!.since).toBe('string');
      expect(claimed.lastFinishedAt).toBeNull();

      adapter.completeJob();

      const done = adapter.vitals();
      expect(done.activeJob).toBeNull();
      expect(done.jobsCompleted).toBe(1);
      expect(done.lastFinishedAt).not.toBeNull();

      adapter.dispose();
    });

    it('bumps lastQueuedEventAt even for announcements it ignores (transport liveness)', async () => {
      const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: ['generation'] });
      adapter.start();

      h.pushEvent('job:queued', { jobId: 'jx', jobType: 'other-type', resourceId: 'r1', userId: 'did:u1' });
      await new Promise((r) => setTimeout(r, 0));

      expect(adapter.vitals().lastQueuedEventAt).not.toBeNull();
      expect(h.emits).toEqual([]); // still filtered — no claim attempted

      adapter.dispose();
    });

    it('touchActivity() stamps lastActivityAt without touching the rest', () => {
      const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });

      adapter.touchActivity();

      const v = adapter.vitals();
      expect(v.lastActivityAt).not.toBeNull();
      expect(v.lastClaimAt).toBeNull();
      expect(v.activeJob).toBeNull();

      adapter.dispose();
    });

    it('failJob stamps lastFinishedAt and clears activeJob without counting a completion', async () => {
      const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
      adapter.start();

      h.pushEvent('job:queued', { jobId: 'jv2', jobType: 'generation', resourceId: 'r1', userId: 'did:u1' });
      await new Promise((r) => setTimeout(r, 0));
      h.pushEvent('job:claimed', {
        correlationId: h.claimAt(0).correlationId,
        response: { params: {}, metadata: { userId: 'u' } },
      });
      await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
      adapter.errors$.subscribe(() => {});

      adapter.failJob('jv2', 'kaboom');

      const v = adapter.vitals();
      expect(v.activeJob).toBeNull();
      expect(v.lastFinishedAt).not.toBeNull();
      expect(v.jobsCompleted).toBe(0);

      adapter.dispose();
    });
  });
});

// ── Checkpoint surfaces on the claimed job (ABANDONED-INFERENCE P2) ───

describe('claimed-job checkpoint (A3)', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('surfaces metadata.completedUnits on the ActiveJob', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'jc1', jobType: 'reference-annotation', resourceId: 'r1', userId: 'did:u1' });
    await new Promise((r) => setTimeout(r, 0));
    h.pushEvent('job:claimed', {
      correlationId: h.claimAt(0).correlationId,
      response: { params: {}, metadata: { userId: 'u1', completedUnits: ['Person', 'Date'] } },
    });

    const active = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    expect(active?.completedUnits).toEqual(['Person', 'Date']);

    adapter.dispose();
  });

  it('surfaces metadata.unitCursors on the ActiveJob (CHUNK-GRAIN-RESUME P3)', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'jc-cur', jobType: 'reference-annotation', resourceId: 'r1', userId: 'did:u1' });
    await new Promise((r) => setTimeout(r, 0));
    h.pushEvent('job:claimed', {
      correlationId: h.claimAt(0).correlationId,
      response: { params: {}, metadata: {
        userId: 'u1', completedUnits: [],
        unitCursors: { Person: { next: 12_400, size: 560, found: 20, emitted: 18 } },
      } },
    });

    const active = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    expect(active?.unitCursors).toEqual({ Person: { next: 12_400, size: 560, found: 20, emitted: 18 } });

    adapter.dispose();
  });

  it('drops a cursor missing its tallies WHOLE rather than resuming without them', async () => {
    // A position without counts would let the retry take the saving and then
    // report a terminal record describing only the remainder — the lie HD3
    // exists to remove. Dropping costs one re-run and yields a true record, and
    // it is also how a checkpoint written before the tallies existed reads.
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'jc-cur2', jobType: 'reference-annotation', resourceId: 'r1', userId: 'did:u1' });
    await new Promise((r) => setTimeout(r, 0));
    h.pushEvent('job:claimed', {
      correlationId: h.claimAt(0).correlationId,
      response: { params: {}, metadata: {
        userId: 'u1', completedUnits: [],
        unitCursors: {
          Person: { next: 12_400, size: 560 },                              // pre-tally shape
          Location: { next: 900, size: 300, found: 4, emitted: 4 },          // complete
        },
      } },
    });

    const active = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    // The position is dropped with the counts — not kept and zero-filled.
    expect(active?.unitCursors).toEqual({ Location: { next: 900, size: 300, found: 4, emitted: 4 } });

    adapter.dispose();
  });

  it('defaults completedUnits to empty when the record carries none', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'jc2', jobType: 'reference-annotation', resourceId: 'r1', userId: 'did:u1' });
    await new Promise((r) => setTimeout(r, 0));
    h.pushEvent('job:claimed', {
      correlationId: h.claimAt(0).correlationId,
      response: { params: {}, metadata: { userId: 'u1' } },
    });

    const active = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    expect(active?.completedUnits).toEqual([]);

    adapter.dispose();
  });
});
