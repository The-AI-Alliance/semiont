import { BehaviorSubject, type Observable } from 'rxjs';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { SemiontApiClient } from '../../client';

export interface WelcomeVM extends ViewModel {
  userData$: Observable<{ termsAcceptedAt?: string } | null>;
  isProcessing$: Observable<boolean>;
  acceptTerms(): Promise<void>;
}

export function createWelcomeVM(
  client: SemiontApiClient,
): WelcomeVM {
  const disposer = createDisposer();

  const userData$ = new BehaviorSubject<{ termsAcceptedAt?: string } | null>(null);
  const isProcessing$ = new BehaviorSubject<boolean>(false);

  client.getMe()
    .then((data) => userData$.next(data as { termsAcceptedAt?: string }))
    .catch(() => {});

  const acceptTerms = async (): Promise<void> => {
    isProcessing$.next(true);
    try {
      await client.acceptTerms();
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
