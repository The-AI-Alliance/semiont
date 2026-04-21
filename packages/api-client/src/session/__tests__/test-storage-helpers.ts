/**
 * Small helpers so the session tests don't reach into the storage module
 * and can express intent directly.
 */

import { InMemorySessionStorage, type SessionStorage } from '../session-storage';

const PREFIX = 'semiont.session.';

export const SESSION_PREFIX_RE = new RegExp(`^${PREFIX.replace('.', '\\.')}`);

export function storageKey(kbId: string): string {
  return `${PREFIX}${kbId}`;
}

export function seedStoredSession(
  storage: SessionStorage,
  kbId: string,
  access: string,
  refresh: string,
): void {
  storage.set(storageKey(kbId), JSON.stringify({ access, refresh }));
}

/**
 * Minimal storage harness for tests that need to drive cross-context sync.
 * `subscribe()` routes to a local subscriber list; `dispatch()` fires
 * whatever handlers are registered, emulating what the `storage` event
 * would do in a browser.
 */
export class TestStorage extends InMemorySessionStorage {
  private handlers: Array<(key: string, newValue: string | null) => void> = [];

  subscribe(handler: (key: string, newValue: string | null) => void): () => void {
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
