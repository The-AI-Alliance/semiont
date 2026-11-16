import { BehaviorSubject, type Observable } from 'rxjs';
import { createDisposer } from '@semiont/sdk';
import type { StateUnit } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';

export interface WelcomeStateUnit extends StateUnit {
  userData$: Observable<{ termsAcceptedAt?: string } | null>;
  isProcessing$: Observable<boolean>;
  acceptTerms(): Promise<void>;
}

// Session-typed (SESSION-TYPED-FACTORIES.md D1): the parameter is the
// lifetime this unit must not outlive. This page crashed in production when
// the unit was constructed with `undefined` during session activation —
// `useSessionStateUnit` + this signature make that unrepresentable.
export function createWelcomeStateUnit(
  session: SemiontSession,
): WelcomeStateUnit {
  const { client } = session;
  const disposer = createDisposer();

  const userData$ = new BehaviorSubject<{ termsAcceptedAt?: string } | null>(null);
  const isProcessing$ = new BehaviorSubject<boolean>(false);

  client.auth!.me()
    .then((data) => userData$.next(data as { termsAcceptedAt?: string }))
    .catch(() => {});

  const acceptTerms = async (): Promise<void> => {
    isProcessing$.next(true);
    try {
      await client.auth!.acceptTerms();
      userData$.next({ ...userData$.getValue(), termsAcceptedAt: new Date().toISOString() });
    } finally {
      isProcessing$.next(false);
    }
  };

  return {
    userData$: userData$.asObservable(),
    isProcessing$: isProcessing$.asObservable(),
    acceptTerms,
    dispose: () => {
      userData$.complete();
      isProcessing$.complete();
      disposer.dispose();
    },
  };
}
