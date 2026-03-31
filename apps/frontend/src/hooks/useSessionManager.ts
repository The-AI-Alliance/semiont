import { useMemo, useEffect } from 'react';
import type { SessionManager } from '@semiont/react-ui';
import { useObservable } from '@semiont/react-ui';
import { useAuth } from '@/hooks/useAuth';
import { SessionStore } from '@/stores/session-store';

/**
 * Hook that provides SessionManager delegating to SessionStore.
 * State lives in a BehaviorSubject; React re-renders via useObservable subscription.
 */
export function useSessionManager(): SessionManager {
  const { token } = useAuth();
  const store = useMemo(() => new SessionStore(), []);

  // Keep store in sync with the current token
  useEffect(() => { store.setToken(token ?? null); }, [store, token]);

  const session = useObservable(store.session$) ?? store.state;

  return session;
}
