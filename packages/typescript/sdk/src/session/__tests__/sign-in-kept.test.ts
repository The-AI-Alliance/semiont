/**
 * A sign-in kept in memory, as every SDK's `MemorySignIn` keeps one: what it
 * holds, keeps in place of what it held, renews against what it holds then,
 * records of the person, and forgets. The sign-in store's entries are held to
 * the same renewals by sign-in-store.test.ts. And a script's sign-out of a
 * kept sign-in: revoked at its issuer, when the issuer says where, and
 * forgotten whatever the issuer answers.
 */

import { describe, it, expect } from 'vitest';
import { MemorySignIn, signOut } from '../sign-in-kept';
import type { StoredSession } from '../storage';

const JO = 'gqB898gk4Ww_orAHhzDCSVl7yHP9UEsX0DA_xbGbq-I';
const ANN = 'oJXMBS_YgRdGkRGgoRP3a1gD4T1VeD9aCS3GlygJEOM';

const signIn = (access: string, refresh: string): StoredSession => ({
  access,
  refresh,
  clientId: 'semiont-browser',
  tokenEndpoint: 'https://issuer.test/token',
});

describe('MemorySignIn', () => {
  it('holds nothing when made with nothing, and what it was made with otherwise', () => {
    expect(new MemorySignIn().held()).toBeNull();
    expect(new MemorySignIn(signIn('a1', 'r1')).held()).toEqual(signIn('a1', 'r1'));
  });

  it('keeps a new sign-in in place of what it held, and forgets', () => {
    const kept = new MemorySignIn(signIn('a1', 'r1'));

    kept.keep(signIn('b1', 's1'));
    expect(kept.held()).toEqual(signIn('b1', 's1'));

    kept.forget();
    expect(kept.held()).toBeNull();
  });

  it('records the person the gateway named on the sign-in it was asked about, and on no other', () => {
    const kept = new MemorySignIn();

    // Nothing kept: nobody is recorded.
    expect(kept.recordPersonKey('a1', JO)).toBe(false);
    expect(kept.held()).toBeNull();

    // A sign-in that holds another access token has moved on: the answer was about a token it no longer holds.
    kept.keep(signIn('a1', 'r1'));
    expect(kept.recordPersonKey('a0', JO)).toBe(false);
    expect(kept.held()?.personKey).toBeUndefined();

    expect(kept.recordPersonKey('a1', JO)).toBe(true);
    expect(kept.held()).toEqual({ ...signIn('a1', 'r1'), personKey: JO });
    // Recorded already, it is recorded: nothing changes.
    expect(kept.recordPersonKey('a1', JO)).toBe(true);
    // Another person is never written over the one it names.
    expect(kept.recordPersonKey('a1', ANN)).toBe(false);
    expect(kept.held()?.personKey).toBe(JO);

    // A sign-in kept in its place is a new one: it names nobody until a gateway names its person.
    kept.keep(signIn('b1', 's1'));
    expect(kept.held()?.personKey).toBeUndefined();
  });

  it('keeps a renewal of what it holds, and the person it names', () => {
    const kept = new MemorySignIn({ ...signIn('a1', 'r1'), personKey: JO });

    expect(kept.renewed(signIn('a1', 'r1'), 'a2', 'r2')).toBe('a2');

    expect(kept.held()).toEqual({ ...signIn('a2', 'r2'), personKey: JO });
  });

  it('gives what it holds, and keeps nothing, when a renewal was of tokens it no longer holds', () => {
    const kept = new MemorySignIn(signIn('b1', 's1'));

    expect(kept.renewed(signIn('a1', 'r1'), 'a2', 'r2')).toBe('b1');

    expect(kept.held()).toEqual(signIn('b1', 's1'));
  });

  it('gives nothing, and keeps nothing, when a renewal finds nothing kept', () => {
    const kept = new MemorySignIn();

    expect(kept.renewed(signIn('a1', 'r1'), 'a2', 'r2')).toBeNull();

    expect(kept.held()).toBeNull();
  });
});

describe('signOut', () => {
  const REVOCATION = 'https://issuer.test/revoke';

  /** An issuer that answers each revocation with `status`, and records what each asked. */
  const issuer = (status: number): { fetch: typeof globalThis.fetch; asked: Record<string, string>[] } => {
    const asked: Record<string, string>[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (input !== REVOCATION || !(init?.body instanceof URLSearchParams)) return new Response(null, { status: 404 });
      asked.push(Object.fromEntries(init.body.entries()));
      return Response.json(status === 200 ? {} : { error: 'invalid_request' }, { status });
    };
    return { fetch, asked };
  };

  it('revokes the refresh token at the issuer the sign-in names, as the client it was issued to, and forgets it', async () => {
    const kept = new MemorySignIn({ ...signIn('a1', 'r1'), revocationEndpoint: REVOCATION });
    const { fetch, asked } = issuer(200);

    await signOut(kept, fetch);

    expect(asked).toEqual([{ token: 'r1', token_type_hint: 'refresh_token', client_id: 'semiont-browser' }]);
    expect(kept.held()).toBeNull();
  });

  it('forgets the sign-in when the issuer refuses the revocation', async () => {
    const kept = new MemorySignIn({ ...signIn('a1', 'r1'), revocationEndpoint: REVOCATION });
    const { fetch, asked } = issuer(400);

    await signOut(kept, fetch);

    expect(asked).toHaveLength(1);
    expect(kept.held()).toBeNull();
  });

  it('forgets a sign-in whose issuer says nowhere to revoke it, and asks nobody', async () => {
    const kept = new MemorySignIn(signIn('a1', 'r1'));
    const { fetch, asked } = issuer(200);

    await signOut(kept, fetch);

    expect(asked).toEqual([]);
    expect(kept.held()).toBeNull();
  });

  it('asks nobody when nothing is kept', async () => {
    const { fetch, asked } = issuer(200);

    await signOut(new MemorySignIn(), fetch);

    expect(asked).toEqual([]);
  });
});
