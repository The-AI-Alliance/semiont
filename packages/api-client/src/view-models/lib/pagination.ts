import { BehaviorSubject, type Observable, combineLatest, map } from 'rxjs';
import type { ViewModel } from './view-model';

export interface PaginationVM extends ViewModel {
  page$: Observable<number>;
  pageSize$: Observable<number>;
  totalItems$: Observable<number>;
  totalPages$: Observable<number>;
  hasNext$: Observable<boolean>;
  hasPrev$: Observable<boolean>;
  setPage(page: number): void;
  nextPage(): void;
  prevPage(): void;
  setTotalItems(total: number): void;
}

export function createPaginationVM(options: { pageSize?: number } = {}): PaginationVM {
  const page$ = new BehaviorSubject<number>(0);
  const pageSize$ = new BehaviorSubject<number>(options.pageSize ?? 20);
  const totalItems$ = new BehaviorSubject<number>(0);

  const totalPages$: Observable<number> = combineLatest([totalItems$, pageSize$]).pipe(
    map(([total, size]) => Math.max(1, Math.ceil(total / size))),
  );

  const hasNext$: Observable<boolean> = combineLatest([page$, totalPages$]).pipe(
    map(([page, total]) => page < total - 1),
  );

  const hasPrev$: Observable<boolean> = page$.pipe(map((p) => p > 0));

  return {
    page$: page$.asObservable(),
    pageSize$: pageSize$.asObservable(),
    totalItems$: totalItems$.asObservable(),
    totalPages$,
    hasNext$,
    hasPrev$,
    setPage: (p) => page$.next(Math.max(0, p)),
    nextPage: () => page$.next(page$.getValue() + 1),
    prevPage: () => page$.next(Math.max(0, page$.getValue() - 1)),
    setTotalItems: (t) => totalItems$.next(t),
    dispose: () => {
      page$.complete();
      pageSize$.complete();
      totalItems$.complete();
    },
  };
}
