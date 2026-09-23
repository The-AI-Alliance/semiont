/**
 * "When does the record learn a person's name?" is ONE question, and the
 * gateway has two emit paths that must answer it identically: `/bus/emit`,
 * which gates on the registry's `effect` axis, and `POST /resources`, which
 * used to hardcode "reaching this line IS the write".
 *
 * A hardcoded second answer is the failure this pins. It cannot drift from
 * the registry because it never consulted it: a channel whose effect changed
 * would move one path and not the other, silently.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { userId } from '@semiont/core';
import { profileForWrite } from '../../identity/person-profile';
import type { Principal } from '../../identity/principal';

const alice: Principal = {
  did: userId('did:web:example.com:users:alice%40example.com'),
  email: 'alice@example.com',
  name: 'Alice Example',
  image: null,
  domain: 'example.com',
};

describe('one rule for publishing a name', () => {
  it('publishes for a channel the registry marks as writing', () => {
    const publish = vi.fn();
    profileForWrite('yield:create', alice, publish);
    expect(publish).toHaveBeenCalledWith('person:profile', {
      _userId: String(alice.did),
      name: 'Alice Example',
    });
  });

  it('publishes for the clone path, which writes by the same rule', () => {
    const publish = vi.fn();
    profileForWrite('yield:clone-persist', alice, publish);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a read', () => {
    const publish = vi.fn();
    profileForWrite('browse:resource-requested', alice, publish);
    expect(publish).not.toHaveBeenCalled();
  });

  it('is the only place either path decides', () => {
    // The upload route must ASK, not assert. A `profileOnce` call there is a
    // second answer to this question, and the registry cannot correct it.
    const create = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../routes/resources/routes/create.ts'),
      'utf-8',
    );
    expect(create).not.toMatch(/\bprofileOnce\b/);
    expect(create).toMatch(/\bprofileForWrite\b/);

    const bus = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../routes/bus.ts'),
      'utf-8',
    );
    expect(bus).not.toMatch(/channelWrites\([^)]*\)\s*\)?\s*profileOnce/);
    expect(bus).toMatch(/\bprofileForWrite\b/);
  });
});
