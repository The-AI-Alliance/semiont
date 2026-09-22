/**
 * createJobClaimAdapter — unit tests.
 *
 * The adapter takes a shared bus and attaches job-claim behaviour. The fake
 * is built over a REAL `EventBus` rather than a `Map` of `Subject<any>`
 * (WORKER-BUS-TYPED-BY-CHANNEL P2): core's bus is already typed per channel,
 * so the fake needs no cast and cannot be fed a payload production would
 * reject — the old `Subject<any>` map accepted anything, which is how this
 * file's `job:queued` fixtures went years without `userId`. No HTTP or SSE.
 *
 * The first block is the PULL model's specification (JOB-DISPATCH-PULL P3),
 * written as the inversion of the edge-triggered cases it replaced: a worker
 * asks the queue at every moment it becomes idle — start, settle, a matching
 * wake-up while parked, reconnect — and never otherwise. Claims are answered
 * here by pushing `job:claimed` / `job:claim-failed` at the correlationId the
 * adapter minted; a decline is `code: 'none-pending'`, which core promotes to
 * `bus.none-pending` on the error the adapter catches.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom, skip, take } from 'rxjs';
import { createJobClaimAdapter, type ClaimRefusal } from '../job-claim-adapter';
import { WORKER_CHANNELS, WORKER_CONSUMED_BROADCASTS } from '../worker-runtime';
import type { BusRequestPrimitive } from '@semiont/core';
import { EventBus, type BusEnvelope, type ConnectionState, type EventMap } from '@semiont/core';

function fakeBus(initialState: ConnectionState = 'open') {
  // A correlated union, not `{ channel: keyof EventMap; payload: <union> }`:
  // the latter pairs every channel with every payload, so `.payload.jobId`
  // would not typecheck even for an emit we know is `job:claim`. This shape
  // lets `channel` narrow `payload` — the same correlation the bus itself
  // now carries.
  type Emitted = { [K in keyof EventMap]: { channel: K; payload: EventMap[K]; correlationId?: string } }[keyof EventMap];
  const emits: Emitted[] = [];
  const eventBus = new EventBus();
  // The transport's connection state, driven by the test for the reconnect
  // case. BehaviorSubject-backed like the real actor's.
  const state$ = new BehaviorSubject<ConnectionState>(initialState);

  const bus: BusRequestPrimitive = {
    stream: <K extends keyof EventMap>(channel: K) => eventBus.on(channel),
    frames: <K extends keyof EventMap>(channel: K) => eventBus.frames(channel),
    // This double delivers whatever a test pushes at it — subjects are created
    // on demand — so `true` is the truth about it. It does not model a
    // NARROWED set; that behavior is proven against the real ActorStateUnit,
    // and against the real worker manifest by this plan's P3.
    isSubscribed: () => true,
    state$,
    emit: vi.fn(async <K extends keyof EventMap>(channel: K, payload: EventMap[K], envelope?: BusEnvelope) => {
      // TypeScript correlates `channel` with `payload` on READ (see
      // `claimAt`) but not on WRITE through a type parameter: while `K` is
      // unresolved it will not accept `{ channel: K; payload: EventMap[K] }`
      // as a member of the mapped union. The pair is correct by
      // construction — they are this call's own two arguments — so this is
      // the harness's single assertion, and it is what buys narrowing at
      // every read site.
      emits.push({ channel, payload, correlationId: envelope?.correlationId } as Emitted);
      return -1;
    }),
  };

  const claims = () => emits.filter((e) => e.channel === 'job:claim');

  return {
    bus,
    state$,
    pushEvent: <K extends keyof EventMap>(channel: K, payload: EventMap[K], correlationId?: string) =>
      eventBus.emit(channel, payload, { correlationId }),
    emits,
    /** Every `job:claim` emitted so far, in order. */
    claims,
    /** The `job:claim` these tests read, narrowed by its channel — no cast. */
    claimAt: (i: number): EventMap['job:claim'] => {
      const e = claims()[i];
      if (!e) throw new Error(`no job:claim at index ${i} (${claims().length} emitted)`);
      return e.payload as EventMap['job:claim'];
    },
    /** The key the adapter minted onto that claim's ENVELOPE. */
    claimCidAt: (i: number): string | undefined => claims()[i]?.correlationId,
    /** Answer claim `i` with a job. */
    grant: (i: number, id: string, extra: Record<string, unknown> = {}) =>
      eventBus.emit('job:claimed', {
        response: { params: {}, metadata: { id, type: 'generation', userId: 'u', ...extra } },
      }, { correlationId: claims()[i]!.correlationId }),
    /** Answer claim `i` with the dispatcher's decline — nothing pending. */
    decline: (i: number) =>
      eventBus.emit('job:claim-failed', { message: 'No pending job of the requested types', code: 'none-pending' }, { correlationId: claims()[i]!.correlationId }),
    /** Answer claim `i` with a refusal carrying `code` (or none). */
    refuse: (i: number, code?: EventMap['job:claim-failed']['code'], message = 'refused') =>
      eventBus.emit('job:claim-failed', code ? { message, code } : { message }, { correlationId: claims()[i]!.correlationId }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const queued = (jobType: string, jobId = 'j'): EventMap['job:queued'] =>
  ({ jobId, jobType, resourceId: 'r1', userId: 'did:u1' });

describe('createJobClaimAdapter — the worker pulls when idle', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('(i) pulls on start, with no announcement, carrying its types', () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: ['generation'] });
    adapter.start();

    expect(h.claims()).toHaveLength(1);
    expect(h.claimAt(0).types).toEqual(['generation']);
    expect(typeof h.claimCidAt(0)).toBe('string');

    adapter.dispose();
  });

  it('(i) waits for the transport to open before the first pull', () => {
    const closed = fakeBus('connecting');
    const adapter = createJobClaimAdapter({ bus: closed.bus, jobTypes: [] });
    adapter.start();
    expect(closed.claims(), 'a claim on a closed transport would only be refused locally').toHaveLength(0);

    closed.state$.next('open');
    expect(closed.claims()).toHaveLength(1);

    adapter.dispose();
  });

  it('(ii) pulls again immediately after completeJob — a second queued job is claimed with no timer', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();
    h.grant(0, 'j1');
    await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    expect(h.claims()).toHaveLength(1);

    adapter.completeJob();

    // The bug's signature, inverted: the next claim is synchronous with the
    // settle. No announcement, no tick, no advance.
    expect(h.claims()).toHaveLength(2);
    expect(await firstValueFrom(adapter.isProcessing$)).toBe(true);

    h.grant(1, 'j2');
    const second = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    expect(second?.jobId).toBe('j2');

    adapter.dispose();
  });

  it('(ii) pulls again immediately after failJob', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();
    adapter.errors$.subscribe(() => {});
    h.grant(0, 'j1');
    await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));

    adapter.failJob('j1', 'kaboom');

    expect(h.claims()).toHaveLength(2);
    adapter.dispose();
  });

  it('(iii) a matching job:queued while parked pulls; a non-matching one does not', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: ['generation'] });
    adapter.start();
    h.decline(0);
    await tick();
    expect(await firstValueFrom(adapter.isProcessing$)).toBe(false);

    h.pushEvent('job:queued', queued('other'));
    expect(h.claims(), 'the pre-filter: no round trip for a type this worker cannot run').toHaveLength(1);

    h.pushEvent('job:queued', queued('generation'));
    expect(h.claims()).toHaveLength(2);
    expect(h.claimAt(1).types).toEqual(['generation']);

    adapter.dispose();
  });

  it('(iii) a job:queued while a job is held is ignored — the settle pull finds it', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();
    h.grant(0, 'j1');
    await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));

    h.pushEvent('job:queued', queued('generation', 'j2'));
    expect(h.claims(), 'no claim while holding a job').toHaveLength(1);

    adapter.completeJob();
    expect(h.claims(), 'the settle asks; the wake-up needed no memory').toHaveLength(2);

    adapter.dispose();
  });

  it('(iv) a wake-up during an in-flight claim earns exactly one more claim before parking', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();
    expect(h.claims()).toHaveLength(1);

    // Two wake-ups land while claim 0 is in flight: one bit, not a counter.
    h.pushEvent('job:queued', queued('generation', 'a'));
    h.pushEvent('job:queued', queued('generation', 'b'));
    expect(h.claims()).toHaveLength(1);

    h.decline(0);
    await tick();
    expect(h.claims(), 'exactly one more').toHaveLength(2);

    h.decline(1);
    await tick();
    expect(h.claims(), 'then parked — no timer exists in the adapter').toHaveLength(2);
    expect(await firstValueFrom(adapter.isProcessing$)).toBe(false);

    adapter.dispose();
  });

  it('(v) none-pending parks quietly: isProcessing$ false, nothing on refused$', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    const refusals: ClaimRefusal[] = [];
    adapter.refused$.subscribe((r) => refusals.push(r));
    adapter.start();

    h.decline(0);
    await tick();

    expect(await firstValueFrom(adapter.isProcessing$)).toBe(false);
    expect(refusals, 'an empty queue is not a fault').toEqual([]);
    expect(h.claims()).toHaveLength(1);

    adapter.dispose();
  });

  it('(vi) pulls on every edge into open — reconnect', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();
    h.decline(0);
    await tick();
    expect(h.claims()).toHaveLength(1);

    h.state$.next('reconnecting');
    expect(h.claims(), 'losing the connection pulls nothing').toHaveLength(1);
    h.state$.next('open');
    expect(h.claims(), 'regaining it asks — whatever was queued in the gap is claimable now').toHaveLength(2);

    h.state$.next('open');
    expect(h.claims(), 'open → open is not an edge').toHaveLength(2);

    adapter.dispose();
  });

  it('(vii) bus.unauthorized surfaces on refused$; the worker holds nothing and parks', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    const refusals: ClaimRefusal[] = [];
    adapter.refused$.subscribe((r) => refusals.push(r));
    adapter.start();

    h.refuse(0, 'unauthorized', 'job:claim refused: the caller is not a worker for this knowledge base');
    await tick();

    expect(refusals).toEqual([{ code: 'bus.unauthorized', message: 'job:claim refused: the caller is not a worker for this knowledge base' }]);
    expect(await firstValueFrom(adapter.activeJob$)).toBeNull();
    expect(await firstValueFrom(adapter.isProcessing$)).toBe(false);
    expect(h.claims(), 'no retry on its own — the runtime decides, and it exits').toHaveLength(1);

    adapter.dispose();
  });

  it('(viii) an unclassified refusal surfaces as bus.rejected and parks', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    const refusals: ClaimRefusal[] = [];
    adapter.refused$.subscribe((r) => refusals.push(r));
    adapter.start();

    h.refuse(0, undefined, 'job:claim: job j9 names no resource to record its assignment under');
    await tick();

    expect(refusals).toEqual([{ code: 'bus.rejected', message: 'job:claim: job j9 names no resource to record its assignment under' }]);
    expect(h.claims()).toHaveLength(1);

    adapter.dispose();
  });

  it('(viii) a record without an id is refused locally with code null, never run', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    const refusals: ClaimRefusal[] = [];
    adapter.refused$.subscribe((r) => refusals.push(r));
    adapter.start();

    h.pushEvent('job:claimed', { response: { params: {}, metadata: {} } }, h.claimCidAt(0));
    await tick();

    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.code, 'a local judgement carries no bus code').toBeNull();
    expect(await firstValueFrom(adapter.activeJob$)).toBeNull();

    adapter.dispose();
  });

  it('job:queued is in the worker MANIFEST — the adapter no longer widens anything', () => {
    // The worker's transport subscribes its manifest, NOT BRIDGED_CHANNELS,
    // so a `job:queued` missing from the manifest is a channel the adapter's
    // own stream can never carry. This assertion was briefly INVERTED
    // (2026-09-16, "redundant with the classification") and every worker sat
    // idle with the frame live on the broker.
    expect(WORKER_CONSUMED_BROADCASTS).toContain('job:queued');
    expect(WORKER_CHANNELS).toContain('job:queued');
  });

  it('a granted claim lands on activeJob$ with the record, and the claim carried a correlationId', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: ['generation'] });
    adapter.start();

    h.pushEvent('job:claimed', {
      response: { params: { foo: 'bar' }, metadata: { id: 'j1', type: 'generation', userId: 'u1' } },
    }, h.claimCidAt(0));

    const active = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    expect(active).toMatchObject({ jobId: 'j1', userId: 'u1', params: { foo: 'bar' } });

    adapter.dispose();
  });

  it('completeJob increments jobsCompleted$ and clears activeJob$', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();
    h.grant(0, 'j3');
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
    // One pull, not two, and one subscription, not two: a wake-up during the
    // in-flight claim sets the bit rather than emitting a second claim.
    h.pushEvent('job:queued', queued('generation', 'j-idem'));
    expect(h.claims()).toHaveLength(1);

    adapter.dispose();
  });

  it('stop() ends pulling: a later settle or wake-up asks nothing', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();
    h.grant(0, 'j1');
    await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));

    adapter.stop();
    adapter.completeJob();
    h.pushEvent('job:queued', queued('generation'));
    h.state$.next('reconnecting');
    h.state$.next('open');

    expect(h.claims()).toHaveLength(1);
    adapter.dispose();
  });

  it('dispose completes all observables', () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });

    const flags = { active: false, proc: false, done: false, errs: false, refused: false };
    adapter.activeJob$.subscribe({ complete: () => { flags.active = true; } });
    adapter.isProcessing$.subscribe({ complete: () => { flags.proc = true; } });
    adapter.jobsCompleted$.subscribe({ complete: () => { flags.done = true; } });
    adapter.errors$.subscribe({ complete: () => { flags.errs = true; } });
    adapter.refused$.subscribe({ complete: () => { flags.refused = true; } });

    adapter.dispose();
    expect(flags).toEqual({ active: true, proc: true, done: true, errs: true, refused: true });
  });

  // ── Vitals (WORKER-LIVENESS.md P1) ─────────────────────────────────
  // The adapter is the only component that sees every wake-up, claim, and
  // finish — its snapshot is what /health and the stall watchdog read.

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
      h.grant(0, 'jv1');
      await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));

      const claimed = adapter.vitals();
      expect(claimed.lastQueuedEventAt, 'no announcement was needed to claim').toBeNull();
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

    it('bumps lastQueuedEventAt even for announcements it filters out', async () => {
      const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: ['generation'] });
      adapter.start();

      h.pushEvent('job:queued', queued('other-type', 'jx'));

      expect(adapter.vitals().lastQueuedEventAt).not.toBeNull();
      expect(h.claims(), 'still filtered — only the start pull').toHaveLength(1);

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
      h.grant(0, 'jv2');
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

    h.grant(0, 'jc1', { completedUnits: ['Person', 'Date'] });

    const active = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    expect(active?.completedUnits).toEqual(['Person', 'Date']);

    adapter.dispose();
  });

  it('surfaces metadata.unitCursors on the ActiveJob (CHUNK-GRAIN-RESUME P3)', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    h.grant(0, 'jc-cursor', {
      completedUnits: [],
      unitCursors: { Person: { next: 12_400, size: 560, found: 20, emitted: 18 } },
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

    h.grant(0, 'jc-cursor', {
      completedUnits: [],
      unitCursors: {
        Person: { next: 12_400, size: 560 },                              // pre-tally shape
        Location: { next: 900, size: 300, found: 4, emitted: 4 },          // complete
      },
    });

    const active = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    // The position is dropped with the counts — not kept and zero-filled.
    expect(active?.unitCursors).toEqual({ Location: { next: 900, size: 300, found: 4, emitted: 4 } });

    adapter.dispose();
  });

  it('defaults completedUnits to empty when the record carries none', async () => {
    const adapter = createJobClaimAdapter({ bus: h.bus, jobTypes: [] });
    adapter.start();

    h.grant(0, 'jc4');

    const active = await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));
    expect(active?.completedUnits).toEqual([]);

    adapter.dispose();
  });
});
