/**
 * Process-wide accessor for `SemiontBrowser`. Constructed lazily on the
 * first `getBrowser()` call and held for the host's lifetime — a single
 * instance owns the KB list, identity token, and active-session state,
 * so callers throughout the host get the same view of "which KB am I
 * talking to right now" regardless of where they pick it up.
 *
 * The caller provides a `SessionStorage` implementation and a
 * `SessionFactory` — both are environment-specific (browsers use
 * `WebBrowserStorage` + `createHttpSessionFactory()`, CLI/embedded
 * hosts use a filesystem adapter and possibly a local-process
 * factory, tests use `InMemorySessionStorage` and stubs). The first
 * call to `getBrowser` wins; subsequent calls return the cached
 * instance regardless of the options passed.
 */

import { SemiontBrowser } from './semiont-browser';
import type { SessionStorage } from './session-storage';
import type { SessionFactory } from './session-factory';

let instance: SemiontBrowser | null = null;

export interface GetBrowserOptions {
  /** Persistence adapter used to construct the singleton on first call. */
  storage: SessionStorage;
  /** Session factory used to build a `SemiontSession` per active KB. */
  sessionFactory: SessionFactory;
}

export function getBrowser(options: GetBrowserOptions): SemiontBrowser {
  if (!instance) {
    instance = new SemiontBrowser({
      storage: options.storage,
      sessionFactory: options.sessionFactory,
    });
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
