/**
 * `profileOnce` — the gateway records what a person is called, when that
 * person ACTS (PERSON-PROFILE D3).
 *
 * The policy is small and every clause of it is load-bearing, so each one is
 * pinned here rather than left to the two call sites to demonstrate:
 * only people, only when named, only when the name is news, and never as a
 * record of mere presence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus, userId } from '@semiont/core';
import { profileOnce, resetProfileCache } from '../../identity/person-profile';
import type { Principal } from '../../identity/principal';

const ALICE = 'did:web:test.local:users:59523dd4-a0e3-4c1c-8c2d-7fcbe3d789dd';
const BOB = 'did:web:test.local:users:8b1f0c22-77aa-4d31-9b0e-1c2d3e4f5a6b';
const WORKER = 'did:web:test.local:agents:anthropic:claude-haiku';

const person = (did: string, name: string | null): Principal =>
  ({ did: userId(did), email: 'x@test.local', name, image: null, domain: 'test.local' }) as Principal;

describe('profileOnce', () => {
  let bus: EventBus;
  let emitted: Array<{ _userId: string; name: string }>;

  beforeEach(() => {
    resetProfileCache();
    bus = new EventBus();
    emitted = [];
    bus.on('person:profile').subscribe((p) => emitted.push(p as never));
  });

  it('emits once for a person the gateway has not profiled', () => {
    profileOnce(person(ALICE, 'Adam Pingel'), bus);

    expect(emitted).toEqual([{ _userId: ALICE, name: 'Adam Pingel' }]);
  });

  it('emits nothing on the next act, or the act after that', () => {
    // The whole reason the cache exists: an hour of work is a dozen tokens
    // and potentially hundreds of acts, every one carrying the same name. Each
    // emit the gateway spares costs the Stower a system-log read.
    profileOnce(person(ALICE, 'Adam Pingel'), bus);
    profileOnce(person(ALICE, 'Adam Pingel'), bus);
    profileOnce(person(ALICE, 'Adam Pingel'), bus);

    expect(emitted).toHaveLength(1);
  });

  it('emits again when the name changes', () => {
    profileOnce(person(ALICE, 'Adma Pingel'), bus);
    profileOnce(person(ALICE, 'Adam Pingel'), bus);

    expect(emitted.map((e) => e.name)).toEqual(['Adma Pingel', 'Adam Pingel']);
  });

  it('emits again when a name changes BACK — the cache holds the last name, not a set', () => {
    // A set of names-seen would swallow this third call, the Stower would
    // never hear it, and the projection would sit permanently on the middle
    // name. The log would be wrong and nothing would say so.
    profileOnce(person(ALICE, 'Adam Pingel'), bus);
    profileOnce(person(ALICE, 'A. Pingel'), bus);
    profileOnce(person(ALICE, 'Adam Pingel'), bus);

    expect(emitted.map((e) => e.name)).toEqual(['Adam Pingel', 'A. Pingel', 'Adam Pingel']);
  });

  it('keeps people apart — one person\'s name does not suppress another\'s', () => {
    profileOnce(person(ALICE, 'Adam Pingel'), bus);
    profileOnce(person(BOB, 'Adam Pingel'), bus);

    expect(emitted.map((e) => e._userId)).toEqual([ALICE, BOB]);
  });

  it('never emits for an agent — a gateway-minted token names a model, not a person', () => {
    profileOnce(person(WORKER, 'claude-haiku'), bus);

    expect(emitted).toEqual([]);
  });

  it('emits nothing when the token carries no name — absence is recorded as absence', () => {
    // The issuer is where a name is set. Inventing one here, or falling back
    // to the email or the subject, would put a value in the log that no
    // reader could tell from a real name.
    profileOnce(person(ALICE, null), bus);

    expect(emitted).toEqual([]);
  });

  it('emits nothing when there is no principal at all', () => {
    profileOnce(undefined, bus);

    expect(emitted).toEqual([]);
  });
});
