/**
 * The log records what a person is CALLED, once per change (PERSON-PROFILE).
 *
 * The gateway emits `person:profile` beside the `_userId` it stamps, so the
 * name is as verified as the DID. The Stower's whole job here is to keep the
 * log honest about how often that fact changed: one line per NAME a subject
 * has had, never one per act. That matters because the gateway re-emits
 * freely — a person's access token lives 300 s, and a second gateway replica
 * has its own de-dup — so every repeat has to die here.
 *
 * Nothing downstream reads the result at write time. No artifact carries a
 * name; readers resolve one from the people projection. These tests therefore
 * assert only what landed on `__system__`, which is the entire contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, type Logger, type ResourceId } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { Stower } from '../stower';

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const ALICE = 'did:web:test:users:59523dd4-a0e3-4c1c-8c2d-7fcbe3d789dd';
const BOB = 'did:web:test:users:8b1f0c22-77aa-4d31-9b0e-1c2d3e4f5a6b';

function fakeStore() {
  const appended: Array<{ type: string; resourceId?: string; userId: string; payload: any }> = [];
  const appendEvent = vi.fn(async (event: { type: string; resourceId?: string; userId: string; payload: any }) => {
    appended.push(event);
    return event;
  });
  /**
   * The raw log, scoped as `EventLog` is — and an event with no `resourceId`
   * lands on `__system__`, which is what `EventStore.appendEvent` does with
   * one. A fake that skipped that would answer every system read with nothing
   * and make the de-dup below look like it worked.
   */
  const log = {
    getEvents: vi.fn(async (rid: ResourceId) =>
      appended.filter((e) => String(e.resourceId ?? '__system__') === String(rid))),
  };
  const profiled = () => appended.filter((e) => e.type === 'person:profiled');
  return { appended, profiled, log, stores: { eventStore: { appendEvent, log } } as never };
}

describe('person:profile — one line per name, not per act', () => {
  let bus: EventBus;
  let stower: Stower;
  let store: ReturnType<typeof fakeStore>;

  beforeEach(async () => {
    vi.clearAllMocks();
    bus = new EventBus();
    store = fakeStore();
    stower = new Stower(store.stores, bus, {} as SemiontProject, silentLogger);
    await stower.initialize();
  });

  afterEach(async () => {
    await stower.stop?.();
    bus.destroy();
  });

  /** The handler runs inside a concatMap; give the queue a turn. */
  const settle = () => new Promise((r) => setTimeout(r, 20));

  const profile = async (did: string | undefined, name: string) => {
    bus.emit('person:profile', { name, ...(did ? { _userId: did } : {}) } as never);
    await settle();
  };

  it('records a name the first time its subject acts', async () => {
    await profile(ALICE, 'Adam Pingel');

    expect(store.profiled()).toHaveLength(1);
    const event = store.profiled()[0]!;
    expect(event.userId, 'the subject is the event\'s emitter, not a payload field').toBe(ALICE);
    expect(event.payload).toEqual({ name: 'Adam Pingel' });
    expect(event.resourceId, 'a fact about the knowledge base, not about a resource').toBeUndefined();
  });

  it('appends nothing when the name has not changed — however often the gateway re-emits', async () => {
    await profile(ALICE, 'Adam Pingel');
    // A 300 s token expires; the next one carries the same claim. A second
    // replica emits its own first-sighting. A gateway restarts. All of it
    // arrives here, and none of it is news.
    await profile(ALICE, 'Adam Pingel');
    await profile(ALICE, 'Adam Pingel');

    expect(store.profiled()).toHaveLength(1);
  });

  it('appends a second line when the name changes, and keeps the first', async () => {
    await profile(ALICE, 'Adma Pingel');
    await profile(ALICE, 'Adam Pingel');

    const names = store.profiled().map((e) => e.payload.name);
    expect(names, 'the history is what makes "what was she called then?" answerable').toEqual(['Adma Pingel', 'Adam Pingel']);
  });

  it('records a change back to an earlier name — latest wins, not set membership', async () => {
    await profile(ALICE, 'Adam Pingel');
    await profile(ALICE, 'A. Pingel');
    await profile(ALICE, 'Adam Pingel');

    expect(store.profiled().map((e) => e.payload.name)).toEqual(['Adam Pingel', 'A. Pingel', 'Adam Pingel']);
  });

  it('keeps subjects apart: one person\'s name is not the other\'s de-dup', async () => {
    await profile(ALICE, 'Adam Pingel');
    await profile(BOB, 'Adam Pingel');
    await profile(ALICE, 'Adam Pingel');

    expect(store.profiled()).toHaveLength(2);
    expect(store.profiled().map((e) => e.userId)).toEqual([ALICE, BOB]);
  });

  it('refuses a command the gateway did not stamp', async () => {
    await profile(undefined, 'Anyone At All');

    // An unstamped command is the pipeline error every other handler treats it
    // as: the identity is the gateway's to assert, and a payload that named
    // its own subject would be exactly the forgery the injection prevents.
    expect(store.profiled()).toHaveLength(0);
  });
});
