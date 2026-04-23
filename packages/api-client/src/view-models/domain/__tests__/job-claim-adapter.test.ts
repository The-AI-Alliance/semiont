/**
 * createJobClaimAdapter — unit tests.
 *
 * The adapter takes a shared ActorVM and attaches job-claim
 * behaviour. We fake the actor with a minimal object that exposes
 * the three methods the adapter uses (`on$`, `emit`, `addChannels`)
 * and drive events through RxJS subjects. No HTTP or SSE involved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Subject, firstValueFrom, skip, take } from 'rxjs';
import type { ActorVM } from '../actor-vm';
import { createJobClaimAdapter } from '../job-claim-adapter';

function fakeActor() {
  const channels = new Set<string>();
  const streams = new Map<string, Subject<any>>();
  const emits: Array<{ channel: string; payload: any }> = [];

  const getStream = (channel: string): Subject<any> => {
    let s = streams.get(channel);
    if (!s) {
      s = new Subject();
      streams.set(channel, s);
    }
    return s;
  };

  const actor: Partial<ActorVM> = {
    addChannels: vi.fn((cs: readonly string[]) => {
      cs.forEach((c) => channels.add(c));
    }),
    on$: vi.fn((channel: string) => getStream(channel).asObservable()),
    emit: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      emits.push({ channel, payload });
    }),
  };

  return {
    actor: actor as ActorVM,
    channels,
    pushEvent: (channel: string, payload: any) => getStream(channel).next(payload),
    emits,
  };
}

describe('createJobClaimAdapter', () => {
  let h: ReturnType<typeof fakeActor>;

  beforeEach(() => {
    h = fakeActor();
  });

  it('ignores job:queued events of the wrong type', async () => {
    const adapter = createJobClaimAdapter({ actor: h.actor, jobTypes: ['generation'] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'j1', jobType: 'other', resourceId: 'r1' });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.emits).toEqual([]);
    expect(await firstValueFrom(adapter.isProcessing$)).toBe(false);

    adapter.dispose();
  });

  it('adds job:queued to the shared actor on start()', () => {
    const adapter = createJobClaimAdapter({ actor: h.actor, jobTypes: [] });
    adapter.start();

    expect(h.channels.has('job:queued')).toBe(true);
    expect(h.actor.addChannels).toHaveBeenCalledWith(['job:queued']);

    adapter.dispose();
  });

  it('claims matching jobs and emits job:claim with a correlationId', async () => {
    const adapter = createJobClaimAdapter({ actor: h.actor, jobTypes: ['generation'] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'j1', jobType: 'generation', resourceId: 'r1' });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.emits).toHaveLength(1);
    const { channel, payload } = h.emits[0]!;
    expect(channel).toBe('job:claim');
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
    const adapter = createJobClaimAdapter({ actor: h.actor, jobTypes: [] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'j2', jobType: 'generation', resourceId: 'r1' });
    await new Promise((r) => setTimeout(r, 0));

    const corrId = h.emits[0]!.payload.correlationId;
    h.pushEvent('job:claim-failed', { correlationId: corrId });

    await new Promise((r) => setTimeout(r, 10));
    expect(await firstValueFrom(adapter.isProcessing$)).toBe(false);

    adapter.dispose();
  });

  it('completeJob increments jobsCompleted$ and clears activeJob$', async () => {
    const adapter = createJobClaimAdapter({ actor: h.actor, jobTypes: [] });
    adapter.start();

    h.pushEvent('job:queued', { jobId: 'j3', jobType: 'generation', resourceId: 'r1' });
    await new Promise((r) => setTimeout(r, 0));
    h.pushEvent('job:claimed', {
      correlationId: h.emits[0]!.payload.correlationId,
      response: { params: {}, metadata: { userId: 'u' } },
    });
    await firstValueFrom(adapter.activeJob$.pipe(skip(1), take(1)));

    adapter.completeJob();

    expect(await firstValueFrom(adapter.activeJob$)).toBeNull();
    expect(await firstValueFrom(adapter.jobsCompleted$)).toBe(1);

    adapter.dispose();
  });

  it('failJob emits on errors$ and clears activeJob$', async () => {
    const adapter = createJobClaimAdapter({ actor: h.actor, jobTypes: [] });
    adapter.start();

    const errorPromise = firstValueFrom(adapter.errors$);

    adapter.failJob('j5', 'kaboom');
    const err = await errorPromise;
    expect(err).toEqual({ jobId: 'j5', error: 'kaboom' });

    adapter.dispose();
  });

  it('start() is idempotent', () => {
    const adapter = createJobClaimAdapter({ actor: h.actor, jobTypes: [] });
    adapter.start();
    adapter.start();
    expect(h.actor.addChannels).toHaveBeenCalledTimes(1);

    adapter.dispose();
  });

  it('dispose completes all observables', () => {
    const adapter = createJobClaimAdapter({ actor: h.actor, jobTypes: [] });

    const flags = { active: false, proc: false, done: false, errs: false };
    adapter.activeJob$.subscribe({ complete: () => { flags.active = true; } });
    adapter.isProcessing$.subscribe({ complete: () => { flags.proc = true; } });
    adapter.jobsCompleted$.subscribe({ complete: () => { flags.done = true; } });
    adapter.errors$.subscribe({ complete: () => { flags.errs = true; } });

    adapter.dispose();
    expect(flags).toEqual({ active: true, proc: true, done: true, errs: true });
  });
});
