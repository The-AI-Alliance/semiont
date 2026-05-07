'use client';

import { useEffect, useState } from 'react';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from './useObservable';

/**
 * Tracks the time remaining on the active KB session's JWT and whether it's
 * expiring soon (< 5 minutes). Reads the session's `expiresAt` getter (which
 * derives from the current `token$` value) and re-derives once per second.
 */
export function useSessionExpiry() {
  const session = useObservable(useSemiont().activeSession$);
  // Subscribe to token$ so we re-run when it changes; expiresAt is derived
  // from the current token on the session.
  useObservable(session?.token$);
  const expiresAt = session?.expiresAt ?? null;
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [isExpiringSoon, setIsExpiringSoon] = useState(false);

  useEffect(() => {
    if (!expiresAt) {
      setTimeRemaining(null);
      setIsExpiringSoon(false);
      return;
    }

    const updateTime = () => {
      const remaining = expiresAt.getTime() - Date.now();
      setTimeRemaining(remaining > 0 ? remaining : 0);
      setIsExpiringSoon(remaining < 5 * 60 * 1000 && remaining > 0);
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  return { timeRemaining, isExpiringSoon };
}
