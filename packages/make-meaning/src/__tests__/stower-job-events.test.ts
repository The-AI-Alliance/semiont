/**
 * Stower's `job:*` handlers — the gateway-injection contract.
 *
 * `_userId` is stamped onto a command by the bus gateway, never by the caller.
 * Every job handler refuses without it rather than appending an event with no
 * actor: these land in the event log, which is the system of record, and a
 * fact with no `userId` is unattributable forever. The refusal is the whole
 * decision in these handlers — the rest is a straight append.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, take } from 'rxjs';
import { EventBus, resourceId, type Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { Stower } from '../stower';

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const RID = 'res-job-under-test';
const USER = 'did:web:test:users:test';

/** Only `eventStore.appendEvent` is exercised by these three handlers. */
function stubStores() {
  const appendEvent = vi.fn().mockResolvedValue(undefined);
  return { appendEvent, stores: { eventStore: { appendEvent } } as never };
}

const jobEvent = (over: Record<string, unknown> = {}) => ({
  jobId: 'job-1',
  jobType: 'detect-references',
  resourceId: RID,
  _userId: USER,
  ...over,
});

describe('Stower job:* handlers', () => {
  let bus: EventBus;
  let stower: Stower;
  let appendEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    bus = new EventBus();
    const s = stubStores();
    appendEvent = s.appendEvent;
    stower = new Stower(s.stores, bus, {} as SemiontProject, silentLogger);
    await stower.initialize();
  });

  afterEach(async () => {
    await stower.stop?.();
    bus.destroy();
  });

  /** The handlers run inside a concatMap; give the microtask queue a turn. */
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('appends job:started with the injected actor', async () => {
    bus.get('job:start').next(jobEvent() as never);
    await settle();

    expect(appendEvent).toHaveBeenCalledTimes(1);
    const event = appendEvent.mock.calls[0][0];
    expect(event.type).toBe('job:started');
    expect(event.resourceId).toBe(resourceId(RID));
    expect(String(event.userId)).toBe(USER);
    expect(event.payload).toMatchObject({ jobId: 'job-1', jobType: 'detect-references' });
  });

  it('carries the job result onto job:completed', async () => {
    bus.get('job:complete').next(jobEvent({ result: { found: 3 } }) as never);
    await settle();

    const event = appendEvent.mock.calls[0][0];
    expect(event.type).toBe('job:completed');
    expect(event.payload.result).toEqual({ found: 3 });
  });

  it('records an annotationId only when the job carries one', async () => {
    // Omitted rather than written as undefined — an absent field and a field
    // present-but-empty are different facts in a log nobody can rewrite.
    bus.get('job:complete').next(jobEvent({ annotationId: 'ann-7' }) as never);
    await settle();
    expect(appendEvent.mock.calls[0][0].payload.annotationId).toBe('ann-7');

    appendEvent.mockClear();
    bus.get('job:complete').next(jobEvent() as never);
    await settle();
    expect('annotationId' in appendEvent.mock.calls[0][0].payload).toBe(false);
  });

  it.each([
    ['job:start'],
    ['job:complete'],
    ['job:fail'],
  ])('refuses %s without the gateway-injected _userId — nothing is appended', async (channel) => {
    bus.get(channel as 'job:start').next(jobEvent({ _userId: undefined }) as never);
    await settle();

    // The refusal must not be a half-write: no event reaches the log at all.
    expect(appendEvent).not.toHaveBeenCalled();
  });

  // ── mark:commit — the durability acknowledgement (JOB-RESTART-SAFETY P6) ───
  //
  // The whole point of this channel is the REPLY. `mark:create` resolves when
  // the bus accepts it, which says nothing about the event log; a worker that
  // advanced on that lost a unit whenever the Archivist was down and hung
  // forever whenever it flapped. These pin the contract the worker now bets a
  // unit's completion on.
  describe('mark:commit', () => {
    const ann = (id: string) => ({
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation', id, motivation: 'linking',
      target: { source: RID },
      creator: { '@type': 'Person', name: 'Detector', '@id': 'did:web:test:agents:detect' },
      created: '2026-09-03T00:00:00.000Z',
    });

    /** First reply on either channel, or 'none' if the seam answers nothing. */
    async function replyOf(fn: () => void): Promise<{ channel: string; body: any }> {
      const ok = firstValueFrom(bus.get('mark:commit-ok').pipe(take(1)));
      const failed = firstValueFrom(bus.get('mark:commit-failed').pipe(take(1)));
      fn();
      return Promise.race([
        ok.then((body) => ({ channel: 'mark:commit-ok', body })),
        failed.then((body) => ({ channel: 'mark:commit-failed', body })),
        new Promise<{ channel: string; body: any }>((r) => setTimeout(() => r({ channel: 'none', body: null }), 300)),
      ]);
    }

    it('appends every annotation in the batch, then acknowledges', async () => {
      const reply = await replyOf(() => bus.get('mark:commit').next({
        correlationId: 'cid-1', resourceId: RID, _userId: USER,
        annotations: [ann('a1'), ann('a2')],
      } as never));

      // Acknowledged only after BOTH appends returned — the ack is a
      // durability claim, so it must not precede the writes it attests to.
      expect(appendEvent).toHaveBeenCalledTimes(2);
      expect(reply.channel).toBe('mark:commit-ok');
      expect(reply.body.correlationId).toBe('cid-1');
      expect(reply.body.response.persisted).toBe(2);
      expect(reply.body.response.annotationIds).toEqual(['a1', 'a2']);
      for (const call of appendEvent.mock.calls) {
        expect(call[0].type).toBe('mark:added');
        expect(String(call[0].userId)).toBe(USER);
      }
    });

    it('reports failure — never partial success — when an append throws', async () => {
      // The batch is the unit. Half a unit acknowledged as done is exactly the
      // silent-loss shape this phase exists to remove, so a failed batch is
      // reported whole and the worker retries it whole.
      appendEvent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('log unwritable'));

      const reply = await replyOf(() => bus.get('mark:commit').next({
        correlationId: 'cid-2', resourceId: RID, _userId: USER,
        annotations: [ann('b1'), ann('b2')],
      } as never));

      expect(reply.channel).toBe('mark:commit-failed');
      expect(reply.body.correlationId).toBe('cid-2');
      expect(reply.body.message).toContain('log unwritable');
      // Stops at the failure rather than pressing on.
      expect(appendEvent).toHaveBeenCalledTimes(2);
    });

    it('acknowledges an empty batch without appending', async () => {
      // A legitimately-empty unit is still a completed unit: the worker must
      // be able to checkpoint it, so the seam has to answer rather than hang.
      const reply = await replyOf(() => bus.get('mark:commit').next({
        correlationId: 'cid-3', resourceId: RID, _userId: USER, annotations: [],
      } as never));

      expect(appendEvent).not.toHaveBeenCalled();
      expect(reply.channel).toBe('mark:commit-ok');
      expect(reply.body.response.persisted).toBe(0);
    });

    it('refuses without the gateway-injected _userId — nothing is appended', async () => {
      const reply = await replyOf(() => bus.get('mark:commit').next({
        correlationId: 'cid-4', resourceId: RID, annotations: [ann('c1')],
      } as never));

      expect(appendEvent).not.toHaveBeenCalled();
      // The guard throws before the try, so no reply is produced — the caller
      // sees its bounded timeout, which is the honest outcome for a command
      // the gateway never stamped.
      expect(reply.channel).toBe('none');
    });
  });
});
