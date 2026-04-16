import { BehaviorSubject, type Observable, combineLatest, map } from 'rxjs';
import type { ViewModel } from './view-model';

export type SortDirection = 'asc' | 'desc';

export interface SortVM<K extends string> extends ViewModel {
  key$: Observable<K>;
  direction$: Observable<SortDirection>;
  setSort(key: K, direction?: SortDirection): void;
  toggleDirection(): void;
  sortedItems$<T>(items$: Observable<T[]>, comparators: Record<K, (a: T, b: T) => number>): Observable<T[]>;
}

export function createSortVM<K extends string>(
  initialKey: K,
  initialDirection: SortDirection = 'asc',
): SortVM<K> {
  const key$ = new BehaviorSubject<K>(initialKey);
  const direction$ = new BehaviorSubject<SortDirection>(initialDirection);

  return {
    key$: key$.asObservable(),
    direction$: direction$.asObservable(),
    setSort: (k, d) => {
      key$.next(k);
      if (d) direction$.next(d);
    },
    toggleDirection: () => direction$.next(direction$.getValue() === 'asc' ? 'desc' : 'asc'),
    sortedItems$: <T>(items$: Observable<T[]>, comparators: Record<K, (a: T, b: T) => number>) =>
      combineLatest([items$, key$, direction$]).pipe(
        map(([items, key, dir]) => {
          const cmp = comparators[key];
          if (!cmp) return items;
          const sorted = [...items].sort(cmp);
          return dir === 'desc' ? sorted.reverse() : sorted;
        }),
      ),
    dispose: () => {
      key$.complete();
      direction$.complete();
    },
  };
}
