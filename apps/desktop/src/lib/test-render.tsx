import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from '../providers';

// React reports work outside `act` unless told it is running under a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Test-only: render `ui` the way the app mounts its screens — inside `AppProviders`, the
 * providers `main.tsx` mounts — into a detached container (a jsdom test). `errors` holds
 * every render error, whether the app's boundary caught it or nothing did, so a test
 * asserts there were none rather than looking for a blank screen.
 */
export async function renderInApp(ui: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const errors: unknown[] = [];
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
    onCaughtError: (error) => errors.push(error),
  });
  await act(async () => {
    root.render(<AppProviders>{ui}</AppProviders>);
  });
  return {
    container,
    errors,
    /** Wait for `done`, or for a render error (which the caller's assertions then name). */
    async until(done: () => boolean, what: string, ms = 5_000): Promise<void> {
      const deadline = Date.now() + ms;
      while (!done() && errors.length === 0) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
    },
    async click(selector: string): Promise<void> {
      const target = container.querySelector(selector);
      if (!(target instanceof HTMLElement)) throw new Error(`nothing to click at ${selector}`);
      await act(async () => {
        target.click();
      });
    },
    unmount(): void {
      act(() => root.unmount());
      container.remove();
    },
  };
}
