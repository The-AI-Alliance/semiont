import { BehaviorSubject, type Observable } from 'rxjs';
import { createDisposer } from '@semiont/sdk';
import type { StateUnit } from '@semiont/core';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import type { SemiontSession } from '@semiont/sdk';

export interface AdminSecurityStateUnit extends StateUnit {
  browse: ShellStateUnit;
  /** The issuer this knowledge base trusts; null when none is configured. */
  issuer$: Observable<string | null>;
  /** What the gateway requires in a token's `aud`; null when none is configured. */
  audience$: Observable<string | null>;
  isLoading$: Observable<boolean>;
}

export function createAdminSecurityStateUnit(
  session: SemiontSession,
  browse: ShellStateUnit,
): AdminSecurityStateUnit {
  const { client } = session;
  const disposer = createDisposer();
  // `browse` (ShellStateUnit) is a *passed-in* dependency owned by the caller
  // (`useShellStateUnit`), not this unit — do NOT add it to the disposer (it's the
  // shared, app-scoped shell). See packages/sdk/docs/STATE-UNITS.md (composition rule).

  const issuer$ = new BehaviorSubject<string | null>(null);
  const audience$ = new BehaviorSubject<string | null>(null);
  const isLoading$ = new BehaviorSubject<boolean>(true);

  client.admin!.oauthConfig()
    .then((config) => {
      issuer$.next(config.issuer ?? null);
      audience$.next(config.audience ?? null);
      isLoading$.next(false);
    })
    .catch(() => isLoading$.next(false));

  return {
    browse,
    issuer$: issuer$.asObservable(),
    audience$: audience$.asObservable(),
    isLoading$: isLoading$.asObservable(),
    dispose: () => {
      issuer$.complete();
      audience$.complete();
      isLoading$.complete();
      disposer.dispose();
    },
  };
}
