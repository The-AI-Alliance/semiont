import { useState, useEffect } from 'react';
import type { Observable } from 'rxjs';

/**
 * Subscribe to an RxJS Observable and return its current value as React state.
 *
 * - Initialises to undefined until the first emission
 * - Unsubscribes automatically on unmount or when `obs$` changes
 */
export function useObservable<T>(obs$: Observable<T>): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    const sub = obs$.subscribe(setValue);
    return () => sub.unsubscribe();
  }, [obs$]);
  return value;
}
