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
import { Stower, type StowerStores } from '../stower';

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const RID = 'res-job-under-test';
const USER = 'did:web:test:users:test';

/**
 * The write seam these handlers use, typed as `StowerStores` rather than cast.
 *
 * It was `as never`, and that cast cost three green tests: when `mark:commit`
 * grew its at-least-once guard (COMMIT-ACK-FALSE-FAILURE F3) and the seam grew
 * `viewStorage`, `tsc` had nothing to check and the stub went on satisfying a
 * shape that no longer existed — the failure surfaced only at runtime, as
 * "Cannot read properties of undefined". Typed, the next widening fails the
 * BUILD here, naming the missing member.
 */
function stubStores() {
  const appendEvent = vi.fn().mockResolvedValue(undefined);
  const stores: StowerStores = {
    content: { register: vi.fn(), move: vi.fn(), remove: vi.fn(), resolveUri: vi.fn() } as unknown as StowerStores['content'],
    eventStore: {
      appendEvent,
      // No resource holds anything yet, so every annotation in a batch is new
      // and every append still runs.
      viewStorage: { get: vi.fn().mockResolvedValue(null) },
    } as unknown as StowerStores['eventStore'],
  };
  return { appendEvent, stores };
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

  // ── job:failed carries the worker's JUDGMENTS, not just its message ──────
  //
  // The durable record must not be lossier than the producer that wrote it.
  // `failureClass` and `willRetry` are computed in the worker, where the error
  // is still typed; at the log they are unrecoverable, because the only other
  // witness is a flattened English string. Without them an auditor reading a
  // run of job:failed events cannot tell a recovering job from a dead one, nor
  // a deterministic refusal from weather — and job:failed is a permanent fact
  // of the resource, not operational state.
  it('persists failureClass and willRetry onto job:failed', async () => {
    bus.get('job:fail').next(jobEvent({
      error: 'Bus request timed out after 60000ms on mark:commit-ok',
      failureClass: 'transient',
      willRetry: true,
    }) as never);
    await settle();

    const event = appendEvent.mock.calls[0][0];
    expect(event.type).toBe('job:failed');
    expect(event.payload).toMatchObject({
      error: 'Bus request timed out after 60000ms on mark:commit-ok',
      failureClass: 'transient',
      willRetry: true,
    });
  });

  it('omits either when the worker did not state it — absent is not false', async () => {
    // Absent `failureClass` means UNRECOGNISED, which is a different claim from
    // 'transient'; `willRetry: false` asserts the run is over. Defaulting either
    // would write a judgment nobody made into a log nobody can rewrite — the
    // same rule the annotationId case above follows.
    bus.get('job:fail').next(jobEvent({ error: 'boom' }) as never);
    await settle();

    const payload = appendEvent.mock.calls[0][0].payload;
    expect('failureClass' in payload).toBe(false);
    expect('willRetry' in payload).toBe(false);
  });

  it.each([
    ['job:complete', 'job:completed', 'probe-confirmed'],
    ['job:fail', 'job:failed', 'probe-unreachable'],
  ])('%s persists how durability was established', async (channel, persisted, durability) => {
    // The evidentiary half of the same rule: an acknowledged completion and one
    // inferred from a probe are different claims, and "the log said no" is a
    // different claim from "the log never answered". Four states, and without
    // this field the log holds two.
    bus.get(channel as 'job:complete').next(jobEvent({ error: 'e', durability }) as never);
    await settle();

    const event = appendEvent.mock.calls[0][0];
    expect(event.type).toBe(persisted);
    expect(event.payload.durability).toBe(durability);
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
