/**
 * The sign-ins `semiont login` keeps, as protocol/specs/src/sign-in-store states
 * them, over files a caller gives: where the launcher's state home is
 * (sign-in-store/cases.json, `cases`), what a renewal of a kept sign-in writes
 * and gives while other programs renew it and sign it out (`renewals`), run
 * through `refreshStoredSession` over the store and over
 * `InMemorySessionStorage`, and what the store hands its caller's files.
 *
 * The files are a directory in memory whose lock excludes every other holder,
 * as the contract's does. Nothing here touches a disk or takes a lock of the
 * system's.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  BROWSER_CLIENT_ID,
  SCRIPT_CLIENT_ID,
  SIGN_IN_STORE_FILE,
  SIGN_IN_STORE_LOCK,
  SIGN_IN_STORE_WINDOWS_OFFSET_HIGH,
  SignInError,
} from '@semiont/core';
import { refreshStoredSession } from '../oauth';
import { httpKb } from '../knowledge-base';
import { SemiontSession, type OpenedSession } from '../semiont-session';
import { InMemorySessionStorage, type SessionStorage } from '../session-storage';
import { SignInStore, stateDir, type SignInFiles, type System } from '../sign-in-store';
import { clearStoredSession, getStoredSession, sessionKey, setStoredSession, type StoredSession } from '../storage';

const SPECS = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../protocol/specs/src/sign-in-store');

interface StateCase {
  why: string;
  os: string;
  home: string | null;
  xdgStateHome?: string | null;
  localAppData?: string | null;
  dir: string | null;
}

/** A sign-in as the table names one: its access token's name and its refresh token. */
interface Named {
  token: string;
  refreshToken: string;
}

interface Renewal {
  why: string;
  kept: Named;
  holding: string | null;
  meanwhile: { when: 'before' | 'during'; does: 'renews'; theirs: Named } | { when: 'before' | 'during'; does: 'signs-out' } | null;
  expired: string[];
  issues: { token: string; refreshToken?: string };
  spends: string | null;
  leaves: Named | null;
  gives: string | null;
}

interface OwnerOnly {
  directoryMode: { value: string };
  fileMode: { value: string };
  accessList: { value: string };
}

const table = JSON.parse(readFileSync(join(SPECS, 'cases.json'), 'utf-8')) as { cases: StateCase[]; renewals: Renewal[] };
const ownerOnly = JSON.parse(readFileSync(join(SPECS, 'owner-only.json'), 'utf-8')) as OwnerOnly;

/** A stack's key, as the launcher keys its sign-ins. */
const KEY = 'local:example.org-my-kb';
const ISSUER = 'https://issuer.test/realms/semiont';
const EMAIL = 'alice@example.org';
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;
const REVOCATION_ENDPOINT = `${ISSUER}/protocol/openid-connect/revoke`;
/** The SID the double's caller runs as, which it gives the access list. */
const OWNER_SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';

/** What a case leaves out is not set (cases.json's `$comment`). */
const given = (value: string | null | undefined): string | null => (value === undefined ? null : value);

const systemOf = (os: string): System => (os === 'macos' || os === 'windows' ? os : 'other');

describe("the launcher's state home (sign-in-store/cases.json, cases)", () => {
  it.each(table.cases.map((c) => [c.why, c] as const))('%s', (_why, c) => {
    expect(stateDir(systemOf(c.os), { home: c.home, xdgStateHome: given(c.xdgStateHome), localAppData: given(c.localAppData) })).toBe(c.dir);
  });
});

/**
 * A directory in memory, as a caller's files keep one on disk. Its lock
 * excludes every other holder: a second taker while it is held fails here,
 * where on disk it would wait, and in one thread wait for ever. It refuses
 * what the contract forbids: a lock taken before the directory is made, and
 * the directory kept to its owner, or the document replaced, without the lock.
 */
class Directory {
  readonly files = new Map<string, string>();
  /** What each program's files were asked to do, in order. */
  readonly done: string[] = [];
  readonly locks: { name: string; mode: number; windowsOffsetHigh: number }[] = [];
  readonly keptToOwner: { mode: number; accessList: string }[] = [];
  readonly replaced: { name: string; mode: number }[] = [];
  private made = false;
  private held = false;

  /** One program's files over this directory. */
  files$(): SignInFiles {
    return {
      makeDirectory: () => {
        this.made = true;
        this.done.push('makeDirectory');
      },
      lock: (name, mode, windowsOffsetHigh) => {
        if (!this.made) throw new Error(`${name} was locked before its directory was made`);
        if (this.held) throw new Error(`${name} is held: a second taker would wait for ever`);
        this.held = true;
        this.locks.push({ name, mode, windowsOffsetHigh });
        this.done.push('lock');
        let released = false;
        return () => {
          if (released) throw new Error(`${name} was released twice`);
          released = true;
          this.held = false;
          this.done.push('release');
        };
      },
      keepToOwner: (mode, accessList) => {
        if (!this.held) throw new Error('the directory was kept to its owner without the lock');
        this.keptToOwner.push({ mode, accessList: accessList(OWNER_SID) });
        this.done.push('keepToOwner');
      },
      read: (name) => {
        this.done.push('read');
        const text = this.files.get(name);
        return text === undefined ? null : text;
      },
      replace: (name, text, mode) => {
        if (!this.held) throw new Error(`${name} was replaced without the lock`);
        this.files.set(name, text);
        this.replaced.push({ name, mode });
        this.done.push('replace');
      },
    };
  }

  /** The document, as the launcher would read it. */
  document(): Record<string, unknown> {
    const text = this.files.get(SIGN_IN_STORE_FILE);
    if (text === undefined) throw new Error('no document was written');
    return JSON.parse(text) as Record<string, unknown>;
  }
}

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.sig`;
}

/** The access tokens of one row: a distinct JWT for each name, expired an hour ago when the row says so. */
class Tokens {
  private readonly minted = new Map<string, string>();
  constructor(private readonly expired: readonly string[]) {}

  of(name: string): string {
    const known = this.minted.get(name);
    if (known !== undefined) return known;
    const hour = this.expired.includes(name) ? -3600 : 3600;
    const token = jwt({ email: EMAIL, iss: ISSUER, exp: Math.floor(Date.now() / 1000) + hour, jti: name });
    this.minted.set(name, token);
    return token;
  }

  nameOf(token: string): string {
    const found = [...this.minted].find(([, minted]) => minted === token);
    if (found === undefined) throw new Error(`${token} is no token this row minted`);
    return found[0];
  }
}

function scriptSession(access: string, refresh: string): StoredSession {
  return { access, refresh, clientId: SCRIPT_CLIENT_ID, tokenEndpoint: TOKEN_ENDPOINT, revocationEndpoint: REVOCATION_ENDPOINT };
}

/** An issuer that answers each refresh grant with `issues`, and records the refresh token each spent. */
function issuerOf(tokens: Tokens, issues: Renewal['issues'], during: () => void): { fetch: typeof globalThis.fetch; spent: (string | null)[] } {
  const spent: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (input !== TOKEN_ENDPOINT || !(init?.body instanceof URLSearchParams)) {
      return new Response(null, { status: 404 });
    }
    spent.push(init.body.get('refresh_token'));
    during();
    const body = { access_token: tokens.of(issues.token), token_type: 'Bearer', expires_in: 3600 };
    return Response.json(issues.refreshToken === undefined ? body : { ...body, refresh_token: issues.refreshToken });
  };
  return { fetch, spent };
}

/** Two programs' storage of one stack's sign-in: this renewer's, and another's. */
interface Programs {
  mine: SessionStorage;
  theirs: SessionStorage;
}

const STORES: [string, () => Programs][] = [
  ['the sign-in store', () => {
    const directory = new Directory();
    return {
      mine: new SignInStore(directory.files$(), new InMemorySessionStorage()),
      theirs: new SignInStore(directory.files$(), new InMemorySessionStorage()),
    };
  }],
  ['InMemorySessionStorage', () => {
    const storage = new InMemorySessionStorage();
    return { mine: storage, theirs: storage };
  }],
];

describe.each(STORES)('a renewal over %s (sign-in-store/cases.json, renewals)', (_store, programs) => {
  it.each(table.renewals.map((row) => [row.why, row] as const))('%s', async (_why, row) => {
    const tokens = new Tokens(row.expired);
    const { mine, theirs } = programs();
    setStoredSession(theirs, KEY, scriptSession(tokens.of(row.kept.token), row.kept.refreshToken));

    const meanwhile = row.meanwhile;
    const theyAct = (): void => {
      if (meanwhile === null) return;
      if (meanwhile.does === 'renews') setStoredSession(theirs, KEY, scriptSession(tokens.of(meanwhile.theirs.token), meanwhile.theirs.refreshToken));
      else clearStoredSession(theirs, KEY);
    };
    if (meanwhile?.when === 'before') theyAct();
    const issuer = issuerOf(tokens, row.issues, meanwhile?.when === 'during' ? theyAct : () => {});

    const gave = await refreshStoredSession(mine, KEY, row.holding === null ? null : tokens.of(row.holding), issuer.fetch);

    expect(issuer.spent).toEqual(row.spends === null ? [] : [row.spends]);
    expect(gave === null ? null : tokens.nameOf(gave)).toBe(row.gives);
    const left = getStoredSession(theirs, KEY);
    expect(left === null ? null : { token: tokens.nameOf(left.access), refreshToken: left.refresh }).toEqual(row.leaves);
  });
});

/** A sign-in as the launcher writes one: who signed in, at which issuer, and where it is renewed. */
function launcherEntry(token: string, refreshToken: string): Record<string, string> {
  return {
    token,
    refreshToken,
    email: EMAIL,
    obtainedAt: '2026-11-05T09:00:00Z',
    issuer: ISSUER,
    tokenEndpoint: TOKEN_ENDPOINT,
    revocationEndpoint: REVOCATION_ENDPOINT,
  };
}

const TO_THE_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('the sign-in store', () => {
  it('hands its files the names, the modes and the access list the contract fixes', () => {
    const directory = new Directory();
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());

    setStoredSession(store, KEY, scriptSession(jwt({ email: EMAIL, iss: ISSUER }), 'refresh-1'));

    expect(directory.locks).toEqual([{ name: SIGN_IN_STORE_LOCK, mode: Number.parseInt(ownerOnly.fileMode.value, 8), windowsOffsetHigh: SIGN_IN_STORE_WINDOWS_OFFSET_HIGH }]);
    expect(directory.keptToOwner).toEqual([{
      mode: Number.parseInt(ownerOnly.directoryMode.value, 8),
      accessList: ownerOnly.accessList.value.replace('{owner}', OWNER_SID),
    }]);
    expect(directory.replaced).toEqual([{ name: SIGN_IN_STORE_FILE, mode: Number.parseInt(ownerOnly.fileMode.value, 8) }]);
  });

  it('holds the lock from before its read until after its rename, and keeps the directory to its owner before it reads', () => {
    const directory = new Directory();
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());

    setStoredSession(store, KEY, scriptSession(jwt({ email: EMAIL, iss: ISSUER }), 'refresh-1'));

    expect(directory.done).toEqual(['makeDirectory', 'lock', 'keepToOwner', 'read', 'replace', 'release']);
  });

  it('never asks its files for the lock while it holds it: a change begun inside another is refused, not waited on', () => {
    const directory = new Directory();
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());
    setStoredSession(store, KEY, scriptSession(jwt({ email: EMAIL, iss: ISSUER }), 'refresh-1'));

    expect(() => store.update(sessionKey(KEY), (held) => {
      clearStoredSession(store, KEY);
      return held;
    })).toThrow(/inside another/);

    expect(directory.locks).toHaveLength(2);
    expect(directory.done.at(-1)).toBe('release');
    expect(getStoredSession(store, KEY)).not.toBeNull();
  });

  it('reads a kept sign-in with no lock, as a session of the script client', () => {
    const directory = new Directory();
    directory.files.set(SIGN_IN_STORE_FILE, JSON.stringify({ [KEY]: launcherEntry('access-1', 'refresh-1') }));
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());

    expect(getStoredSession(store, KEY)).toEqual(scriptSession('access-1', 'refresh-1'));
    expect(directory.done).toEqual(['read']);
  });

  it('reads no session from a sign-in that has no refresh token, and none from a member that is no sign-in', () => {
    const directory = new Directory();
    const { refreshToken: _none, ...unrenewable } = launcherEntry('access-1', 'refresh-1');
    directory.files.set(SIGN_IN_STORE_FILE, JSON.stringify({ [KEY]: unrenewable, other: { token: 7 } }));
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());

    expect(getStoredSession(store, KEY)).toBeNull();
    expect(getStoredSession(store, 'other')).toBeNull();
  });

  it('keeps a sign-in as its access token names who signed in and at which issuer', () => {
    const directory = new Directory();
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());
    const exp = Math.floor(Date.now() / 1000) + 300;
    const access = jwt({ email: EMAIL, iss: ISSUER, exp });

    setStoredSession(store, KEY, scriptSession(access, 'refresh-1'));

    expect(directory.document()[KEY]).toEqual({
      token: access,
      refreshToken: 'refresh-1',
      email: EMAIL,
      obtainedAt: expect.stringMatching(TO_THE_SECOND),
      expiresAt: new Date(exp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      issuer: ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      revocationEndpoint: REVOCATION_ENDPOINT,
    });
  });

  it('keeps a sign-in whose access token names no address without one', () => {
    const directory = new Directory();
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());

    setStoredSession(store, KEY, scriptSession(jwt({ iss: ISSUER }), 'refresh-1'));

    expect(directory.document()[KEY]).not.toHaveProperty('email');
  });

  it('keeps no sign-in whose access token names no issuer, writes nothing, and lets the lock go', () => {
    const directory = new Directory();
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());

    let refused: unknown = null;
    try {
      setStoredSession(store, KEY, scriptSession(jwt({ email: EMAIL }), 'refresh-1'));
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(SignInError);
    expect(refused).toMatchObject({ code: 'exchange', message: `The sign-in to ${KEY} was not kept: its access token names no issuer` });
    expect(directory.files.has(SIGN_IN_STORE_FILE)).toBe(false);
    expect(directory.done.at(-1)).toBe('release');
  });

  it('a renewal keeps who signed in and the issuer as the sign-in learned them', async () => {
    const directory = new Directory();
    directory.files.set(SIGN_IN_STORE_FILE, JSON.stringify({ [KEY]: launcherEntry('access-1', 'refresh-1') }));
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());
    const renewed = jwt({ email: 'someone-else@example.org', iss: 'https://another.test', exp: Math.floor(Date.now() / 1000) + 300 });
    const fetch: typeof globalThis.fetch = async () => Response.json({ access_token: renewed, refresh_token: 'refresh-2' });

    expect(await refreshStoredSession(store, KEY, 'access-1', fetch)).toBe(renewed);

    expect(directory.document()[KEY]).toMatchObject({ token: renewed, refreshToken: 'refresh-2', email: EMAIL, issuer: ISSUER });
  });

  it('writes back what is not a sign-in as it was', () => {
    const directory = new Directory();
    const later = { kept: 'by a later release', nested: { list: [1, 2] } };
    directory.files.set(SIGN_IN_STORE_FILE, JSON.stringify({ later, [KEY]: launcherEntry('access-1', 'refresh-1') }));
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());

    clearStoredSession(store, KEY);

    expect(directory.document()).toEqual({ later });
  });

  it('reads a document that is no JSON object as an error, never as empty, and writes nothing over it', () => {
    for (const text of ['[]', '{"local": ', 'null']) {
      const directory = new Directory();
      directory.files.set(SIGN_IN_STORE_FILE, text);
      const store = new SignInStore(directory.files$(), new InMemorySessionStorage());

      expect(() => getStoredSession(store, KEY)).toThrow();
      expect(() => setStoredSession(store, KEY, scriptSession(jwt({ iss: ISSUER }), 'refresh-1'))).toThrow();
      expect(directory.files.get(SIGN_IN_STORE_FILE)).toBe(text);
      expect(directory.done.at(-1)).toBe('release');
    }
  });

  it('keeps a session another client was issued in the storage beneath, and reads it before the file', () => {
    const directory = new Directory();
    directory.files.set(SIGN_IN_STORE_FILE, JSON.stringify({ [KEY]: launcherEntry('access-1', 'refresh-1') }));
    const beneath = new InMemorySessionStorage();
    const store = new SignInStore(directory.files$(), beneath);
    const browsers: StoredSession = { ...scriptSession('access-b', 'refresh-b'), clientId: BROWSER_CLIENT_ID };

    setStoredSession(store, KEY, browsers);

    expect(getStoredSession(beneath, KEY)).toEqual(browsers);
    expect(getStoredSession(store, KEY)).toEqual(browsers);
    expect(directory.document()[KEY]).toEqual(launcherEntry('access-1', 'refresh-1'));
  });

  it('keeps what is not a session in the storage beneath, and takes no lock for it', () => {
    const directory = new Directory();
    const beneath = new InMemorySessionStorage();
    const store = new SignInStore(directory.files$(), beneath);

    store.set('semiont.activeKnowledgeBaseId', KEY);

    expect(beneath.get('semiont.activeKnowledgeBaseId')).toBe(KEY);
    expect(store.get('semiont.activeKnowledgeBaseId')).toBe(KEY);
    expect(directory.done).toEqual([]);
  });

  it("a sign-in of the script client takes the place of this program's own session of the stack", () => {
    const directory = new Directory();
    const beneath = new InMemorySessionStorage();
    const store = new SignInStore(directory.files$(), beneath);
    setStoredSession(store, KEY, { ...scriptSession('access-b', 'refresh-b'), clientId: BROWSER_CLIENT_ID });
    const access = jwt({ email: EMAIL, iss: ISSUER });

    setStoredSession(store, KEY, scriptSession(access, 'refresh-1'));

    expect(beneath.get(sessionKey(KEY))).toBeNull();
    expect(getStoredSession(store, KEY)).toEqual(scriptSession(access, 'refresh-1'));
  });
});

describe('SemiontSession.fromStoredSession', () => {
  const kb = httpKb({ id: KEY, label: 'My KB', host: 'localhost', port: 4000, protocol: 'http' });
  let opened: OpenedSession | null = null;

  afterEach(() => {
    opened?.dispose();
    opened = null;
  });

  it('gives no session when nothing is kept for the knowledge base', async () => {
    const store = new SignInStore(new Directory().files$(), new InMemorySessionStorage());

    expect(await SemiontSession.fromStoredSession({ kb, storage: store, baseUrl: 'http://localhost:4000' })).toBeNull();
  });

  it('starts with the kept access token, and renews it through the store', async () => {
    const directory = new Directory();
    const tokens = new Tokens([]);
    directory.files.set(SIGN_IN_STORE_FILE, JSON.stringify({ [KEY]: launcherEntry(tokens.of('access-1'), 'refresh-1') }));
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());
    const issuer = issuerOf(tokens, { token: 'access-2', refreshToken: 'refresh-2' }, () => {});

    opened = await SemiontSession.fromStoredSession({ kb, storage: store, baseUrl: 'http://localhost:4000', fetch: issuer.fetch });
    expect(opened?.session.token$.getValue()).toBe(tokens.of('access-1'));

    expect(await opened?.session.refresh(tokens.of('access-1'))).toBe(tokens.of('access-2'));
    expect(issuer.spent).toEqual(['refresh-1']);
    expect(directory.document()[KEY]).toMatchObject({ token: tokens.of('access-2'), refreshToken: 'refresh-2', email: EMAIL, issuer: ISSUER });
  });

  it('at its start renews a kept access token that has expired', async () => {
    const directory = new Directory();
    const tokens = new Tokens(['access-1']);
    directory.files.set(SIGN_IN_STORE_FILE, JSON.stringify({ [KEY]: launcherEntry(tokens.of('access-1'), 'refresh-1') }));
    const store = new SignInStore(directory.files$(), new InMemorySessionStorage());
    const issuer = issuerOf(tokens, { token: 'access-2', refreshToken: 'refresh-2' }, () => {});

    opened = await SemiontSession.fromStoredSession({ kb, storage: store, baseUrl: 'http://localhost:4000', fetch: issuer.fetch });

    expect(issuer.spent).toEqual(['refresh-1']);
    expect(opened?.session.token$.getValue()).toBe(tokens.of('access-2'));
    expect(directory.document()[KEY]).toMatchObject({ token: tokens.of('access-2'), refreshToken: 'refresh-2' });
  });
});
