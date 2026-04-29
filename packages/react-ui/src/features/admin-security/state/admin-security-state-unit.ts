import { BehaviorSubject, type Observable } from 'rxjs';
import { createDisposer } from '@semiont/sdk';
import type { StateUnit } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import type { SemiontClient } from '@semiont/sdk';

export interface AdminSecurityStateUnit extends StateUnit {
  browse: ShellStateUnit;
  providers$: Observable<unknown[]>;
  allowedDomains$: Observable<string[]>;
  isLoading$: Observable<boolean>;
}

export function createAdminSecurityStateUnit(
  client: SemiontClient,
  browse: ShellStateUnit,
): AdminSecurityStateUnit {
  const disposer = createDisposer();
  disposer.add(browse);

  const providers$ = new BehaviorSubject<unknown[]>([]);
  const allowedDomains$ = new BehaviorSubject<string[]>([]);
  const isLoading$ = new BehaviorSubject<boolean>(true);

  client.admin!.oauthConfig()
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
