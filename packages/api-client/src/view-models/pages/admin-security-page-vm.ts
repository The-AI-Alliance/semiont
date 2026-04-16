import { BehaviorSubject, type Observable } from 'rxjs';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { BrowseVM } from '../flows/browse-vm';
import type { SemiontApiClient } from '../../client';

export interface AdminSecurityPageVM extends ViewModel {
  browse: BrowseVM;
  providers$: Observable<unknown[]>;
  allowedDomains$: Observable<string[]>;
  isLoading$: Observable<boolean>;
}

export function createAdminSecurityPageVM(
  client: SemiontApiClient,
  browse: BrowseVM,
): AdminSecurityPageVM {
  const disposer = createDisposer();
  disposer.add(browse);

  const providers$ = new BehaviorSubject<unknown[]>([]);
  const allowedDomains$ = new BehaviorSubject<string[]>([]);
  const isLoading$ = new BehaviorSubject<boolean>(true);

  client.getOAuthConfig()
    .then((data) => {
      const config = data as { providers?: unknown[]; allowedDomains?: string[] };
      providers$.next(config.providers ?? []);
      allowedDomains$.next(config.allowedDomains ?? []);
      isLoading$.next(false);
    })
    .catch(() => isLoading$.next(false));

  return {
    browse,
    providers$: providers$.asObservable(),
    allowedDomains$: allowedDomains$.asObservable(),
    isLoading$: isLoading$.asObservable(),
    dispose: () => {
      providers$.complete();
      allowedDomains$.complete();
      isLoading$.complete();
      disposer.dispose();
    },
  };
}
