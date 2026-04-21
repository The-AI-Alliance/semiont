import { BehaviorSubject, type Observable } from 'rxjs';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { ShellVM } from '../flows/shell-vm';
import type { SemiontApiClient } from '../../client';

export interface AdminSecurityVM extends ViewModel {
  browse: ShellVM;
  providers$: Observable<unknown[]>;
  allowedDomains$: Observable<string[]>;
  isLoading$: Observable<boolean>;
}

export function createAdminSecurityVM(
  client: SemiontApiClient,
  browse: ShellVM,
): AdminSecurityVM {
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
