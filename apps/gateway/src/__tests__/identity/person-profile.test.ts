/**
 * `profileOnce` — the gateway records what a person is called, when that
 * person ACTS (PERSON-PROFILE D3).
 *
 * The policy is small and every clause of it is load-bearing, so each one is
 * pinned here rather than left to the two call sites to demonstrate:
 * only people, only when named, only when the name is news, and never as a
 * record of mere presence.
 *
 * The double is a PUBLISH FUNCTION, not an `EventBus` — and that is the point.
 * An earlier version of these tests handed `profileOnce` a real in-process bus
 * and subscribed to it, which passes whether or not the frame ever leaves the
 * gateway. It did not: under `[signal] type = "nats"` the Stower is in the
 * Archivist, so every profile was dropped on a live stack while this file
 * stayed green. `PublishFrame` now makes an `EventBus` un-passable, and these
 * assert what was published rather than what a local subscriber saw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { channelWrites, userId } from '@semiont/core';
import { profileOnce, type PublishFrame } from '../../identity/person-profile';
import type { Principal } from '../../identity/principal';

const ALICE = 'did:web:test.local:users:59523dd4-a0e3-4c1c-8c2d-7fcbe3d789dd';
const BOB = 'did:web:test.local:users:8b1f0c22-77aa-4d31-9b0e-1c2d3e4f5a6b';
const WORKER = 'did:web:test.local:agents:anthropic:claude-haiku';

const person = (did: string, name: string | null): Principal =>
  ({ did: userId(did), email: 'x@test.local', name, image: null, domain: 'test.local' }) as Principal;

describe('profileOnce', () => {
  let publish: PublishFrame & ReturnType<typeof vi.fn>;
  let emitted: Array<{ _userId: string; name: string }>;

  beforeEach(() => {
    emitted = [];
    publish = vi.fn<PublishFrame>((_channel, payload) => {
      emitted.push(payload);
    }) as PublishFrame & ReturnType<typeof vi.fn>;
  });

  it('emits once for a person the gateway has not profiled', () => {
    profileOnce(person(ALICE, 'Adam Pingel'), publish);

    expect(emitted).toEqual([{ _userId: ALICE, name: 'Adam Pingel' }]);
    // The channel matters as much as the payload: it is what the Archivist's
    // roster subscribes, and the route publishes it through the plane.
    expect(publish).toHaveBeenCalledWith('person:profile', { _userId: ALICE, name: 'Adam Pingel' });
  });

  it('publishes on EVERY write — no de-dup here, because there is nothing to trust', () => {
    // The gateway cannot know the Stower received anything: the publish is
    // fire-and-forget. A cache set at publish time records "I sent a frame",
    // and one dropped frame then suppressed a person for the life of the
    // process on a live stack. De-dup belongs to the Stower, which reads the
    // log it is about to append to.
    profileOnce(person(ALICE, 'Adam Pingel'), publish);
    profileOnce(person(ALICE, 'Adam Pingel'), publish);
    profileOnce(person(ALICE, 'Adam Pingel'), publish);

    expect(emitted).toHaveLength(3);
  });

  it('carries whatever the token says, change after change', () => {
    profileOnce(person(ALICE, 'Adma Pingel'), publish);
    profileOnce(person(ALICE, 'Adam Pingel'), publish);

    expect(emitted.map((e) => e.name)).toEqual(['Adma Pingel', 'Adam Pingel']);
  });

  it('keeps people apart — one person\'s name does not suppress another\'s', () => {
    profileOnce(person(ALICE, 'Adam Pingel'), publish);
    profileOnce(person(BOB, 'Adam Pingel'), publish);

    expect(emitted.map((e) => e._userId)).toEqual([ALICE, BOB]);
  });

  it('never emits for an agent — a gateway-minted token names a model, not a person', () => {
    profileOnce(person(WORKER, 'claude-haiku'), publish);

    expect(emitted).toEqual([]);
  });

  it('emits nothing when the token carries no name — absence is recorded as absence', () => {
    // The issuer is where a name is set. Inventing one here, or falling back
    // to the email or the subject, would put a value in the log that no
    // reader could tell from a real name.
    profileOnce(person(ALICE, null), publish);

    expect(emitted).toEqual([]);
  });

  it('emits nothing when there is no principal at all', () => {
    profileOnce(undefined, publish);

    expect(emitted).toEqual([]);
  });

  it('reading is not writing: only an emit that changes the record counts as an act', () => {
    // The defect this closes: the hook used to sit beside the `_userId`
    // injection and fire for every emit. A `browse:*` request carries a
    // `_userId` too, so opening a resource named the reader in the log —
    // the opposite of the ruling that the record is of acts, not presence.
    //
    // The answers come from the bus registry's `effect` axis, so this asserts
    // the DECISION reaches the gateway, not a list kept here. Its completeness
    // is the registry validator's job and its agreement with the actors is the
    // Archivist census gate's.
    expect(channelWrites('mark:create-request')).toBe(true);
    expect(channelWrites('yield:create')).toBe(true);
    expect(channelWrites('frame:add-entity-type')).toBe(true);
    // The two that a Stower-roster gate could never have covered: both re-emit
    // into a channel the Stower owns, and neither is in that roster.
    expect(channelWrites('bind:update-body')).toBe(true);
    expect(channelWrites('yield:clone-create')).toBe(true);

    expect(channelWrites('browse:resource-requested')).toBe(false);
    expect(channelWrites('browse:resources-requested')).toBe(false);
    expect(channelWrites('browse:annotations-requested')).toBe(false);
    expect(channelWrites('gather:requested')).toBe(false);
    expect(channelWrites('match:search-requested')).toBe(false);
    // Minting a clone token and redeeming one look alike and are not: the
    // first two leave nothing behind, the create persists a resource.
    expect(channelWrites('yield:clone-token-requested')).toBe(false);
    expect(channelWrites('yield:clone-resource-requested')).toBe(false);
  });

  it('answers false for anything nobody emits', () => {
    // `mark:create` appends — but it is in-process: the Archivist re-emits it
    // after `mark:create-request` crosses the wire, so no client emit ever
    // carries it and the axis has no opinion. False is the honest answer to
    // "did this emit change the record", because there was no such emit.
    expect(channelWrites('mark:create')).toBe(false);
    expect(channelWrites('mark:added')).toBe(false);
    expect(channelWrites('not-a-channel-at-all')).toBe(false);
  });
});
