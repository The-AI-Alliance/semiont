import { BehaviorSubject, type Observable } from 'rxjs';
import type { StateUnit } from '@semiont/sdk';
import type { SemiontClient } from '@semiont/sdk';

export interface SessionStateUnit extends StateUnit {
  isLoggingOut$: Observable<boolean>;
  logout(): Promise<void>;
}

export function createSessionStateUnit(
  client: SemiontClient,
): SessionStateUnit {
  const isLoggingOut$ = new BehaviorSubject<boolean>(false);

  const logout = async (): Promise<void> => {
    isLoggingOut$.next(true);
    try {
      await client.auth!.logout();
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
