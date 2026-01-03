'use client';

'use client';

import { useState, useEffect } from 'react';
import { useSessionContext } from '../contexts/SessionContext';

export function useSessionExpiry() {
  const { expiresAt } = useSessionContext();
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

    // Initial update
    updateTime();

    // Update every second
    const interval = setInterval(updateTime, 1000);

    // Cleanup interval on unmount or when expiresAt changes
    return () => clearInterval(interval);
  }, [expiresAt]);

  return { timeRemaining, isExpiringSoon };
}