/**
 * Module-scoped singleton for SemiontBrowser. Constructed lazily on first
 * `getBrowser()` call, survives every React re-render, remount, and route
 * change. Client-only: throws if called on the server to prevent a single
 * process-wide instance from leaking tokens across HTTP requests.
 */

import { SemiontBrowser } from './semiont-browser';

let instance: SemiontBrowser | null = null;

export function getBrowser(): SemiontBrowser {
  if (typeof window === 'undefined') {
    throw new Error(
      'SemiontBrowser is client-only. It must not be constructed on the server — ' +
      'a single process-wide instance would leak tokens between HTTP requests. ' +
      'Wrap any code path that calls getBrowser() in "use client".',
    );
  }
  if (!instance) instance = new SemiontBrowser();
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
