/**
 * SessionStorage — environment-agnostic persistence adapter for the
 * Semiont session layer. Decouples `SemiontSession` / `SemiontBrowser`
 * from `localStorage` / `window` so the same classes can run in a
 * browser, a CLI process, or tests without environment guards.
 *
 * Implementations shipped here:
 *  - `InMemorySessionStorage` — map-backed, for scripts and tests.
 *
 * Browser-backed (`WebBrowserStorage`) lives in `@semiont/react-ui`
 * because it touches browser-only globals.
 */

/**
 * A store of text by key. More than one context can write one store (two
 * windows, two processes): what is written from what was read goes through
 * `update`, which a store makes one step, so one writer's change is never
 * lost under another's; and `subscribe` hears what another context writes.
 */
export interface SessionStorage {
  /** What is stored under `key`; null when nothing is. */
  get(key: string): string | null;
  /** Store `value` under `key`, in place of what was there. */
  set(key: string, value: string): void;
  /** Remove a key. One that is not there is left not there. */
  delete(key: string): void;
  /**
   * Change a key's value as one step: `change` is given what is stored,
   * null when nothing is, and says what is stored next, null for nothing.
   * No other writer's change falls between the read and the write.
   */
  update(key: string, change: (stored: string | null) => string | null): void;
  /**
   * Hear what another context writes: another process, another window.
   * `handler` is given the key, and the value written, or null when the key
   * was removed. Returns what ends the subscription, or null where the
   * environment has no other context: a client then works correctly within
   * its own.
   */
  subscribe(handler: (key: string, newValue: string | null) => void): (() => void) | null;
}

/** Map-backed `SessionStorage`. No other context writes it. */
export class InMemorySessionStorage implements SessionStorage {
  private readonly map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  update(key: string, change: (stored: string | null) => string | null): void {
    const next = change(this.get(key));
    if (next === null) this.map.delete(key);
    else this.map.set(key, next);
  }

  subscribe(_handler: (key: string, newValue: string | null) => void): (() => void) | null {
    return null;
  }
}
