'use client';

import { useEffect, useState } from 'react';
import { useKnowledgeBaseSession } from '../contexts/KnowledgeBaseSessionContext';

/**
 * Tracks the time remaining on the active KB session's JWT and whether it's
 * expiring soon (< 5 minutes). Re-derives once per second from the
 * KnowledgeBaseSession context.
 */
export function useSessionExpiry() {
  const { expiresAt } = useKnowledgeBaseSession();
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
