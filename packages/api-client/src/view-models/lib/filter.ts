import { BehaviorSubject, type Observable } from 'rxjs';
import type { ViewModel } from './view-model';

export interface FilterVM<K> extends ViewModel {
  selected$: Observable<K | null>;
  select(value: K | null): void;
  clear(): void;
}

export function createFilterVM<K>(initial: K | null = null): FilterVM<K> {
  const selected$ = new BehaviorSubject<K | null>(initial);

  return {
    selected$: selected$.asObservable(),
    select: (v) => selected$.next(v),
    clear: () => selected$.next(null),
    dispose: () => selected$.complete(),
  };
}
