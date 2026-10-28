/**
 * WebBrowserStorage — browser-backed `SessionStorage` implementation.
 * Wraps `localStorage` for reads/writes and `window`'s `storage` event
 * for cross-tab change notifications.
 *
 * Construction requires a browser context. The guard matches the
 * existing registry behavior: server rendering that accidentally
 * instantiates this gets a loud error rather than a silent no-op
 * that would mask token leaks.
 */

import type { SessionStorage } from '@semiont/sdk';
export class WebBrowserStorage implements SessionStorage {
  constructor() {
    if (typeof window === 'undefined') {
      throw new Error(
        'WebBrowserStorage is client-only. It must not be constructed on ' +
        'the server — a single process-wide instance would leak tokens ' +
        'between HTTP requests. Wrap any code path that constructs this ' +
        'in "use client".',
      );
    }
  }

  get(key: string): string | null {
    return localStorage.getItem(key);
  }

  set(key: string, value: string): void {
    localStorage.setItem(key, value);
  }

  delete(key: string): void {
    localStorage.removeItem(key);
  }

  subscribe(handler: (key: string, newValue: string | null) => void): () => void {
    const listener = (e: StorageEvent): void => {
      if (e.key === null) return;
      handler(e.key, e.newValue);
    };
    window.addEventListener('storage', listener);
    return () => {
      window.removeEventListener('storage', listener);
    };
  }
}
