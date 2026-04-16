import { BehaviorSubject, type Observable, map } from 'rxjs';
import type { ViewModel } from './view-model';

export interface MultiSelectVM<T> extends ViewModel {
  selected$: Observable<Set<T>>;
  count$: Observable<number>;
  isSelected(item: T): boolean;
  toggle(item: T): void;
  select(item: T): void;
  deselect(item: T): void;
  selectAll(items: T[]): void;
  clear(): void;
}

export function createMultiSelectVM<T>(): MultiSelectVM<T> {
  const selected$ = new BehaviorSubject<Set<T>>(new Set());

  const count$: Observable<number> = selected$.pipe(map((s) => s.size));

  return {
    selected$: selected$.asObservable(),
    count$,
    isSelected: (item) => selected$.getValue().has(item),
    toggle: (item) => {
      const next = new Set(selected$.getValue());
      if (next.has(item)) next.delete(item); else next.add(item);
      selected$.next(next);
    },
    select: (item) => {
      const next = new Set(selected$.getValue());
      next.add(item);
      selected$.next(next);
    },
    deselect: (item) => {
      const next = new Set(selected$.getValue());
      next.delete(item);
      selected$.next(next);
    },
    selectAll: (items) => selected$.next(new Set(items)),
    clear: () => selected$.next(new Set()),
    dispose: () => selected$.complete(),
  };
}
