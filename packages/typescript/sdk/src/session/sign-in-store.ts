/**
 * The sign-ins `semiont login` keeps (protocol/specs/src/sign-in-store): one
 * sign-in serves the launcher's verbs and a program built on this SDK.
 *
 * The launcher keeps one sign-in per stack, under the stack's key. A program
 * reaches one through `entry(key)`, where it is kept: a session over that
 * entry (`SemiontSession.fromKept`) starts with its tokens and renews them
 * there.
 *
 * What is in the file was issued to the script client and is renewed as it:
 * an entry keeps no sign-in another client was issued, which the launcher
 * would renew as the wrong client.
 *
 * **A sign-in that is kept** states who signed in and at which issuer as its
 * own access token names them. **A renewal of it** keeps both as the sign-in
 * learned them.
 *
 * The SDK reaches no file and takes no lock itself: its caller's
 * `SignInFiles` does both, as the system it runs on does them. What the
 * contract fixes (the names, the modes, the access list, the byte locked on
 * Windows) the store hands to those files.
 */

import {
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  SCRIPT_CLIENT_ID,
  SIGN_IN_STORE_FILE,
  SIGN_IN_STORE_LOCK,
  SIGN_IN_STORE_WINDOWS_OFFSET_HIGH,
  SignInError,
  isObject,
  isSignIn,
  ownerOnlyAccessList,
  type SignIn,
} from '@semiont/core';
import type { SignInKept } from './sign-in-kept';
import { parseJwtExpiry, textClaim, type StoredSession } from './storage';

/** The systems whose state homes differ. */
export type System = 'macos' | 'windows' | 'other';

/**
 * The launcher's state home, the directory that holds the sign-in store, on
 * `system`, from what its environment says: `home` is HOME (USERPROFILE on
 * Windows), `xdgStateHome` XDG_STATE_HOME, and `localAppData` LOCALAPPDATA.
 * An empty value is one that is not set. Null when there is no home, and so
 * no state home. Written with `system`'s separator, whatever system computes
 * it (protocol/specs/src/sign-in-store/cases.json, `cases`).
 */
export function stateDir(
  system: System,
  environment: { home: string | null; xdgStateHome: string | null; localAppData: string | null },
): string | null {
  const { home, xdgStateHome, localAppData } = environment;
  if (!isSet(home)) return null;
  switch (system) {
    case 'macos':
      return under('/', home, 'Library', 'Application Support', 'semiont');
    case 'windows':
      return isSet(localAppData) ? under('\\', localAppData, 'semiont') : under('\\', home, 'AppData', 'Local', 'semiont');
    case 'other':
      return isSet(xdgStateHome) ? under('/', xdgStateHome, 'semiont') : under('/', home, '.local', 'state', 'semiont');
  }
}

function isSet(value: string | null): value is string {
  return value !== null && value !== '';
}

function under(separator: string, base: string, ...names: string[]): string {
  let trimmed = base;
  while (trimmed.endsWith(separator)) trimmed = trimmed.slice(0, -1);
  return [trimmed, ...names].join(separator);
}

/**
 * The files of one directory, as the system a program runs on reaches them:
 * what a `SignInStore` reads, writes and locks there. A caller builds it over
 * the directory the store is in (`stateDir`, for the launcher's), and the
 * store names each file and states each mode. To share the store with the
 * launcher and the other SDKs, it does what protocol/specs/src/sign-in-store/README.md
 * requires of every writer:
 *
 * - `lock` is the lock every writer takes, and excludes each of them: on
 *   Unix `flock(2)`, exclusive, never `fcntl` or `lockf` record locks, which
 *   on Linux do not exclude a `flock`; on Windows `LockFileEx`, exclusive, on
 *   the one byte at offset `windowsOffsetHigh` × 2³² (Offset 0, OffsetHigh
 *   `windowsOffsetHigh`, one byte long), or on the whole file, which holds
 *   that byte too (README.md, Writing it). Its file is opened for reading and
 *   writing, made with `mode` when it is not there, and never renamed or
 *   removed. It waits until the lock is held, and gives what lets it go.
 * - The lock is held from before the read until after the rename (README.md,
 *   Writing it): the store calls `keepToOwner`, `read` and `replace` between
 *   taking it and letting it go, and `read` alone when it only reads.
 * - The store never asks for the lock while it holds it: the lock is not
 *   reentrant, and a second taker in the same process waits on the first as
 *   one in another process does.
 *
 * Every member throws what it could not do, and the store lets that through.
 */
export interface SignInFiles {
  /** Make the directory, and those above it, where they are not there. */
  makeDirectory(): void;
  /** Hold the exclusive lock on `name`, as the contract states it (above), waiting until it is held. */
  lock(name: string, mode: number, windowsOffsetHigh: number): () => void;
  /**
   * Keep the directory to its owner (README.md, Where it is): on a system
   * with modes, give it `mode`; on Windows, where a mode keeps nobody out,
   * the access list `accessList(owner)`, `owner` being the SID of the user
   * this process runs as (its token's user). A directory that has the list
   * already is left as it is: the two are compared as Windows writes each
   * out, with their entries in any order.
   */
  keepToOwner(mode: number, accessList: (owner: string) => string): void;
  /** The text of `name`; null when it is not there. */
  read(name: string): string | null;
  /**
   * Replace `name` with `text` as one step: write it to a temporary file
   * beside it, made with `mode`, and rename that over `name`, so no reader
   * sees half of it; the temporary file is removed when that fails.
   */
  replace(name: string, text: string, mode: number): void;
}

/** A member of the document as a sign-in that can be renewed, as the sign-in a client holds; null when it is none. */
function heldOf(member: unknown): StoredSession | null {
  if (!isSignIn(member) || member.refreshToken === undefined || member.refreshToken === '') return null;
  return {
    access: member.token,
    refresh: member.refreshToken,
    clientId: SCRIPT_CLIENT_ID,
    tokenEndpoint: member.tokenEndpoint,
    ...(member.revocationEndpoint === undefined ? {} : { revocationEndpoint: member.revocationEndpoint }),
  };
}

/** RFC 3339, in UTC, to the second. */
function toTheSecond(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Who signed in, at which issuer, and where it is renewed, as a sign-in states them. */
type Learned = Pick<SignIn, 'email' | 'issuer' | 'tokenEndpoint' | 'revocationEndpoint'>;

/** The tokens `access` and `refresh` as the sign-in the file keeps of what `learned` states, obtained now. */
function entryOf(learned: Learned, access: string, refresh: string): SignIn {
  const expiry = parseJwtExpiry(access);
  return {
    token: access,
    refreshToken: refresh,
    ...(learned.email === undefined ? {} : { email: learned.email }),
    obtainedAt: toTheSecond(new Date()),
    ...(expiry === null ? {} : { expiresAt: toTheSecond(expiry) }),
    issuer: learned.issuer,
    tokenEndpoint: learned.tokenEndpoint,
    ...(learned.revocationEndpoint === undefined ? {} : { revocationEndpoint: learned.revocationEndpoint }),
  };
}

/** See the module's documentation. */
export class SignInStore {
  /** Whether a change is being made: one at a time, since the lock is not reentrant. */
  private changing = false;

  /** The store in `files`' directory. */
  constructor(private readonly files: SignInFiles) {}

  /** Where the sign-in of the stack `key` is kept. */
  entry(key: string): SignInKept {
    return {
      held: () => heldOf(this.read().get(key)),
      keep: (signIn) => {
        if (signIn.clientId !== SCRIPT_CLIENT_ID) {
          throw new Error(`The sign-in store keeps what the client ${SCRIPT_CLIENT_ID} was issued, and this was issued to ${signIn.clientId}`);
        }
        // A gateway admits no token from an issuer it does not trust: a token
        // that names no issuer is no sign-in.
        const issuer = textClaim(signIn.access, 'iss');
        if (issuer === null) throw new SignInError('exchange', `The sign-in to ${key} was not kept: its access token names no issuer`);
        const email = textClaim(signIn.access, 'email');
        const learned: Learned = {
          ...(email === null ? {} : { email }),
          issuer,
          tokenEndpoint: signIn.tokenEndpoint,
          ...(signIn.revocationEndpoint === undefined ? {} : { revocationEndpoint: signIn.revocationEndpoint }),
        };
        this.change((document) => {
          document.set(key, entryOf(learned, signIn.access, signIn.refresh));
          return true;
        });
      },
      renewed: (read, access, refresh) => {
        let given: string | null = null;
        this.change((document) => {
          const before = document.get(key);
          if (!isSignIn(before)) return false;
          // Another program renewed, or signed in again, while this renewal's
          // grant was in flight: its tokens stand. The refresh token alone does
          // not tell, since an issuer that rotates none leaves it as it was.
          if (before.token !== read.access || before.refreshToken !== read.refresh) {
            given = before.token;
            return false;
          }
          document.set(key, entryOf(before, access, refresh));
          given = access;
          return true;
        });
        return given;
      },
      forget: () => this.change((document) => document.delete(key)),
      // An entry has no member for the person: what a session keeps for them is kept nowhere.
      recordPersonKey: () => false,
    };
  }

  /** The document as it is now. A file that is not there holds nothing; one that is no JSON object is an error. */
  private read(): Map<string, unknown> {
    const text = this.files.read(SIGN_IN_STORE_FILE);
    if (text === null) return new Map();
    const document: unknown = JSON.parse(text);
    if (!isObject(document)) throw new Error(`${SIGN_IN_STORE_FILE} holds no JSON object`);
    return new Map(Object.entries(document));
  }

  /**
   * Change the document as one step: read it, change it, and write it when
   * `change` says it changed, with the lock held throughout and the directory
   * kept to its owner before the read.
   */
  private change(change: (document: Map<string, unknown>) => boolean): void {
    if (this.changing) throw new Error('A change to the sign-in store was begun inside another: its lock is held, and is not taken twice');
    this.changing = true;
    try {
      this.files.makeDirectory();
      const release = this.files.lock(SIGN_IN_STORE_LOCK, OWNER_ONLY_FILE_MODE, SIGN_IN_STORE_WINDOWS_OFFSET_HIGH);
      try {
        this.files.keepToOwner(OWNER_ONLY_DIRECTORY_MODE, ownerOnlyAccessList);
        const document = this.read();
        if (change(document)) {
          this.files.replace(SIGN_IN_STORE_FILE, `${JSON.stringify(Object.fromEntries(document), null, 2)}\n`, OWNER_ONLY_FILE_MODE);
        }
      } finally {
        release();
      }
    } finally {
      this.changing = false;
    }
  }
}
