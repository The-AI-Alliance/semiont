/**
 * Module-scoped singleton for SemiontBrowser. Constructed lazily on first
 * `getBrowser()` call, survives every React re-render, remount, and route
 * change.
 *
 * The default build uses `WebBrowserStorage` (localStorage + `storage`
 * event). Tests can override by passing `{ storage }`.
 */

import { SemiontBrowser } from './semiont-browser';
import type { SessionStorage } from './session-storage';
import { WebBrowserStorage } from './web-browser-storage';

let instance: SemiontBrowser | null = null;

export interface GetBrowserOptions {
  /** Inject a specific storage adapter. Omit for `WebBrowserStorage`. */
  storage?: SessionStorage;
}

export function getBrowser(options?: GetBrowserOptions): SemiontBrowser {
  if (!instance) {
    const storage = options?.storage ?? new WebBrowserStorage();
    instance = new SemiontBrowser({ storage });
  }
  return instance;
}

/**
 * Test-only reset hook. Exported from the `@semiont/react-ui/session/testing`
 * subpath, NOT from the main entry — production code cannot import it.
 */
export async function __resetForTests(): Promise<void> {
  if (instance) {
    await instance.dispose();
    instance = null;
  }
}
