/**
 * SessionStorage — environment-agnostic persistence adapter for the
 * Semiont session layer. Decouples `SemiontSession` / `SemiontBrowser`
 * from `localStorage` / `window` so the same classes can run in a
 * browser, a CLI process, or tests without environment guards.
 *
 * Implementations shipped here:
 *  - `InMemorySessionStorage` — map-backed, for tests.
 *
 * Browser-backed (`WebBrowserStorage`) lives in its own file because
 * it touches browser-only globals.
 */

/** String key/value store with optional cross-context change subscription. */
export interface SessionStorage {
  /** Read a string value; null if absent. */
  get(key: string): string | null;
  /** Write a string value. */
  set(key: string, value: string): void;
  /** Remove a key. No-op if absent. */
  delete(key: string): void;
  /**
   * Optional: subscribe to external changes (cross-tab, cross-process).
   * Browser implements via the `storage` event; filesystem would use
   * fs.watch; in-memory omits this method. Returns an unsubscribe
   * callback. If omitted, cross-context sync simply isn't available
   * in that environment — the session still works correctly within a
   * single process.
   */
  subscribe?(handler: (key: string, newValue: string | null) => void): () => void;
}

/**
 * Map-backed `SessionStorage`. Cross-context sync is not implemented;
 * tests that need it can drive it manually.
 */
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
}
