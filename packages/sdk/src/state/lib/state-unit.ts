import { Subscription } from 'rxjs';
import type { StateUnit } from '@semiont/core';

/**
 * Compose multiple disposers into a single `dispose()` call. Accepts either
 * a `StateUnit` (whose `dispose()` will be invoked) or a plain teardown
 * function. The returned object is itself disposable; call its `dispose()`
 * once to tear down everything that was added.
 */
export function createDisposer(): {
  add(item: StateUnit | (() => void)): void;
  dispose(): void;
} {
  const sub = new Subscription();
  return {
    add: (item) =>
      sub.add(typeof item === 'function' ? item : () => item.dispose()),
    dispose: () => sub.unsubscribe(),
  };
}
