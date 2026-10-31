/**
 * Small helpers so the session tests don't reach into the storage module
 * and can express intent directly.
 */

import { InMemorySessionStorage, type SessionStorage } from '../session-storage';
import type { StoredSession } from '../storage';

const PREFIX = 'semiont.session.';

export const SESSION_PREFIX_RE = new RegExp(`^${PREFIX.replace('.', '\\.')}`);

/** The issuer every seeded session came from; refresh tests point their fetch stub here. */
export const TEST_TOKEN_ENDPOINT = 'https://issuer.test/realms/semiont/protocol/openid-connect/token';
export const TEST_REVOCATION_ENDPOINT = 'https://issuer.test/realms/semiont/protocol/openid-connect/revoke';

export function storageKey(kbId: string): string {
  return `${PREFIX}${kbId}`;
}

/** A stored session as the Browser's sign-in would persist it. */
export function testSession(access: string, refresh: string): StoredSession {
  return {
    access,
    refresh,
    clientId: 'semiont-browser',
    tokenEndpoint: TEST_TOKEN_ENDPOINT,
    revocationEndpoint: TEST_REVOCATION_ENDPOINT,
  };
}

export function seedStoredSession(
  storage: SessionStorage,
  kbId: string,
  access: string,
  refresh: string,
): void {
  storage.set(storageKey(kbId), JSON.stringify(testSession(access, refresh)));
}

/**
 * Minimal storage harness for tests that need to drive cross-context sync.
 * `subscribe()` routes to a local subscriber list; `dispatch()` fires
 * whatever handlers are registered, emulating what the `storage` event
 * would do in a browser.
 */
export class TestStorage extends InMemorySessionStorage {
  private handlers: Array<(key: string, newValue: string | null) => void> = [];

  override subscribe(handler: (key: string, newValue: string | null) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Fire all subscribed handlers. Use in tests to simulate a cross-tab write. */
  dispatch(key: string, newValue: string | null): void {
    for (const h of this.handlers) h(key, newValue);
  }
}

/** What every context's handle on a `SharedStorage` reads and writes, and who listens from which context. */
interface Shared {
  stored: Map<string, string>;
  listeners: Map<number, { context: number; heard: (key: string, newValue: string | null) => void }>;
  contexts: number;
  subscriptions: number;
}

/**
 * One context's handle on a storage several share, for tests of what one
 * context does when another writes. Each context hears what the others write,
 * never what it wrote itself: how two windows on one `localStorage` see each
 * other. Made holding nothing, as the first context's handle; `context` is
 * another's.
 */
export class SharedStorage implements SessionStorage {
  private shared: Shared = { stored: new Map(), listeners: new Map(), contexts: 0, subscriptions: 0 };
  private contextId = 0;

  /** Another context's handle on the same storage. */
  context(): SharedStorage {
    this.shared.contexts += 1;
    const other = new SharedStorage();
    other.shared = this.shared;
    other.contextId = this.shared.contexts;
    return other;
  }

  get(key: string): string | null {
    return this.shared.stored.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.shared.stored.set(key, value);
    this.tell(key, value);
  }

  delete(key: string): void {
    this.shared.stored.delete(key);
    this.tell(key, null);
  }

  update(key: string, change: (stored: string | null) => string | null): void {
    const next = change(this.get(key));
    if (next === null) this.shared.stored.delete(key);
    else this.shared.stored.set(key, next);
    this.tell(key, next);
  }

  subscribe(handler: (key: string, newValue: string | null) => void): () => void {
    this.shared.subscriptions += 1;
    const subscription = this.shared.subscriptions;
    this.shared.listeners.set(subscription, { context: this.contextId, heard: handler });
    return () => {
      this.shared.listeners.delete(subscription);
    };
  }

  private tell(key: string, newValue: string | null): void {
    for (const { context, heard } of [...this.shared.listeners.values()]) {
      if (context !== this.contextId) heard(key, newValue);
    }
  }
}
