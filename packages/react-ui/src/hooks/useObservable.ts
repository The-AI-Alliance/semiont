import { useState, useEffect } from 'react';
import type { Observable } from 'rxjs';

/**
 * Subscribe to an RxJS Observable and return its current value as React state.
 *
 * - For a `BehaviorSubject` (or anything with a `getValue()` method), returns
 *   its current value synchronously at the first render. This matters for
 *   callers that build derived objects in a `useState(factory)` initializer
 *   at first render — they need the subject's value present immediately, not
 *   after a second render triggered by the useEffect subscribe.
 *
 *   We duck-type on `.getValue` rather than using `instanceof BehaviorSubject`
 *   because rxjs can be loaded through multiple module realms in tests (e.g.
 *   a bundled CJS copy inside `@semiont/react-ui/dist` vs a fresh ESM import
 *   in the test file), which makes `instanceof` unreliable.
 * - For non-BehaviorSubject Observables, starts at `undefined` and emits
 *   asynchronously after the subscribe.
 * - Accepts `undefined`/`null` for cases where the observable's source isn't
 *   ready yet (e.g. `semiont?.browse.events(rUri)` when the active session is
 *   still loading). In that case the hook is a no-op and returns undefined.
 * - Unsubscribes automatically on unmount or when `obs$` changes.
 */
export function useObservable<T>(obs$: Observable<T> | null | undefined): T | undefined {
  const [value, setValue] = useState<T | undefined>(() => {
    if (!obs$) return undefined;
    const getValue = (obs$ as unknown as { getValue?: () => T }).getValue;
    return typeof getValue === 'function' ? getValue.call(obs$) : undefined;
  });
  useEffect(() => {
    if (!obs$) return;
    const sub = obs$.subscribe(setValue);
    return () => sub.unsubscribe();
  }, [obs$]);
  return value;
}
