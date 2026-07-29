import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  map,
  type Observable,
  type Subscription,
} from 'rxjs';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import type { StateUnit } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

export interface ResourceLoaderStateUnit extends StateUnit {
  resource$: Observable<ResourceDescriptor | undefined>;
  isLoading$: Observable<boolean>;
  /** Terminal load failure (B15), or null. Cleared by any value or `invalidate()`. */
  error$: Observable<Error | null>;
  invalidate(): void;
}

/**
 * Load one resource, in three states: loading, loaded, failed.
 *
 * The third state is not optional. `browse.resource()` delivers a terminal
 * failure as an RxJS *error* notification (B15) when the B14 retry is
 * exhausted with nothing cached — and a key that failed has no value either,
 * so a (value | no value) model reports a dead request as an eternal spinner
 * and drops the reason entirely. This unit catches the notification here so
 * that (a) consumers can render the failure and retry it, and (b) it never
 * escapes to RxJS as an unhandled rethrow.
 * See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md (D4)
 */
export function createResourceLoaderStateUnit(
  session: SemiontSession,
  resourceId: ResourceId,
): ResourceLoaderStateUnit {
  const { client } = session;
  const resource$ = new BehaviorSubject<ResourceDescriptor | undefined>(undefined);
  const error$ = new BehaviorSubject<Error | null>(null);

  let subscription: Subscription | null = null;
  let disposed = false;

  /**
   * (Re)subscribe to this key. An errored observable is terminated, so
   * recovery needs a fresh subscription — which is also what re-arms the
   * cache: `observe()` clears the B15 failure marker and starts a new
   * attempt chain for a key it is asked about again.
   */
  const attach = (): void => {
    if (disposed) return;
    subscription?.unsubscribe();
    subscription = client.browse.resource(resourceId).subscribe({
      next: (value) => {
        // A value arrived — the key is live again, whatever came before.
        if (error$.getValue() !== null) error$.next(null);
        resource$.next(value);
      },
      error: (e: unknown) => {
        error$.next(e instanceof Error ? e : new Error(String(e)));
      },
    });
  };
  attach();

  const isLoading$ = combineLatest([resource$, error$]).pipe(
    map(([resource, error]) => resource === undefined && error === null),
    distinctUntilChanged(),
  );

  return {
    // X1: owned subjects are published read-only.
    resource$: resource$.asObservable(),
    isLoading$,
    error$: error$.asObservable(),
    invalidate: () => {
      if (disposed) return;
      error$.next(null);
      client.browse.invalidateResourceDetail(resourceId);
      attach();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      subscription?.unsubscribe();
      subscription = null;
      resource$.complete();
      error$.complete();
    },
  };
}
