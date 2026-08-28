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
});
