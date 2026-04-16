import { BehaviorSubject, type Observable } from 'rxjs';
import type { ViewModel } from '../lib/view-model';
import type { SemiontApiClient } from '../../client';

export interface SessionVM extends ViewModel {
  isLoggingOut$: Observable<boolean>;
  logout(): Promise<void>;
}

export function createSessionVM(
  client: SemiontApiClient,
): SessionVM {
  const isLoggingOut$ = new BehaviorSubject<boolean>(false);

  const logout = async (): Promise<void> => {
    isLoggingOut$.next(true);
    try {
      await client.logout();
    } catch {
      // best-effort — session may already be cleared server-side
    } finally {
      isLoggingOut$.next(false);
    }
  };

  return {
    isLoggingOut$: isLoggingOut$.asObservable(),
    logout,
    dispose: () => {
      isLoggingOut$.complete();
    },
  };
}
