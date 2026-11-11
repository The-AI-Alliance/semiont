/**
 * Where one knowledge base's sign-in is kept, as every SDK keeps one: what a
 * session reads its tokens from, renews them into and forgets. A sign-in
 * holds the tokens an issuer issued, the client they were issued to, the
 * issuer's endpoints a renewal and a sign-out need, learned once at sign-in
 * so no session asks again, and the key of the person a gateway said the
 * tokens are (`personKey`), absent until one has.
 *
 * Three hold one: `keptIn`, a registry's storage, under the knowledge base's
 * session key; `MemorySignIn`, the life of the process; and an entry of the
 * `SignInStore`, the sign-in `semiont login` keeps. Every member runs as one
 * step, so a check of what is kept and the write it guards are never apart.
 */

import { SignInError } from '@semiont/core';
import { revokeAtIssuer } from './oauth';
import type { StoredSession } from './storage';

export interface SignInKept {
  /** The sign-in as it is kept now; null when there is none. */
  held(): StoredSession | null;
  /** Keep a new sign-in, in place of whatever was kept. */
  keep(signIn: StoredSession): void;
  /**
   * Keep the tokens a renewal of `read` issued, against what is kept now:
   * the access token kept then. When what is kept no longer holds `read`'s
   * tokens, it was renewed some other way meanwhile: that stands, and its
   * access token is the one given. Null when nothing is kept: a sign-in that
   * was signed out, or ended, while it was being renewed is gone, and is not
   * written back.
   */
  renewed(read: StoredSession, access: string, refresh: string): string | null;
  /** Keep the sign-in no more. */
  forget(): void;
  /**
   * Record `personKey`, the key of the person a gateway said `access` is, on
   * the sign-in kept now, as one step: only when it still holds `access` and
   * names nobody yet. True when it then names that person, recorded now or
   * before; false when nothing is kept, what is kept holds another token, or
   * names another person, or where it is kept has no place for a person.
   * What a session's caches and stream places are kept under follows it.
   */
  recordPersonKey(access: string, personKey: string): boolean;
}

/** A sign-in kept for as long as the process lives, and no longer. */
export class MemorySignIn implements SignInKept {
  private signIn: StoredSession | null;

  constructor(signIn: StoredSession | null = null) {
    this.signIn = signIn;
  }

  held(): StoredSession | null {
    return this.signIn;
  }

  keep(signIn: StoredSession): void {
    this.signIn = signIn;
  }

  renewed(read: StoredSession, access: string, refresh: string): string | null {
    const kept = this.signIn;
    if (kept === null) return null;
    if (kept.access !== read.access || kept.refresh !== read.refresh) return kept.access;
    this.signIn = { ...kept, access, refresh };
    return access;
  }

  forget(): void {
    this.signIn = null;
  }

  recordPersonKey(access: string, personKey: string): boolean {
    const kept = this.signIn;
    if (kept === null || kept.access !== access) return false;
    if (kept.personKey === undefined) {
      this.signIn = { ...kept, personKey };
      return true;
    }
    return kept.personKey === personKey;
  }
}

/**
 * End the sign-in `kept` holds: it is revoked at its issuer, when the issuer
 * says where, and kept no more. It is forgotten whatever the issuer answers:
 * a person who signs out is signed out here, and an issuer that could not be
 * told forgets the token when it expires. The issuer is told with `fetch`, or
 * the runtime's own.
 */
export async function signOut(kept: SignInKept, fetch?: typeof globalThis.fetch): Promise<void> {
  const held = kept.held();
  if (held === null) return;
  try {
    if (held.revocationEndpoint !== undefined) {
      await revokeAtIssuer(held.revocationEndpoint, held.clientId, held.refresh, fetch);
    }
  } catch (error) {
    // Best effort: an issuer that could not be told forgets the token when it expires.
    if (!(error instanceof SignInError)) throw error;
  } finally {
    kept.forget();
  }
}
