/**
 * Module-scoped singleton for SemiontBrowser. Constructed lazily on first
 * `getBrowser()` call, survives every React re-render, remount, and route
 * change.
 *
 * The caller provides a `SessionStorage` implementation — there is no
 * default here because storage-backend selection is environment-specific
 * (browsers use `WebBrowserStorage`, CLI uses a filesystem adapter,
 * tests use `InMemorySessionStorage`). The first call to `getBrowser`
 * wins; subsequent calls return the cached instance regardless of the
 * storage passed.
 */

import { SemiontBrowser } from './semiont-browser';
import type { SessionStorage } from './session-storage';

let instance: SemiontBrowser | null = null;

export interface GetBrowserOptions {
  /** Persistence adapter used to construct the singleton on first call. */
  storage: SessionStorage;
}

export function getBrowser(options: GetBrowserOptions): SemiontBrowser {
  if (!instance) {
    instance = new SemiontBrowser({ storage: options.storage });
  }
  return instance;
}

/**
 * Test-only reset hook. Tests import this to clear the singleton between
 * runs. Production code must not import it.
 */
export async function __resetForTests(): Promise<void> {
  if (instance) {
    await instance.dispose();
    instance = null;
  }
}
