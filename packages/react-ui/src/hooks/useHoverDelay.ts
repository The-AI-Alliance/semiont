'use client';

import { useState, useCallback } from 'react';
import { HOVER_DELAY_MS } from './useBeckonFlow';

/**
 * Hook to manage hover delay setting with localStorage persistence
 */
export function useHoverDelay() {
  const [hoverDelayMs, setHoverDelayMsState] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('hoverDelayMs');
      return stored ? Number(stored) : HOVER_DELAY_MS;
    }
    return HOVER_DELAY_MS;
  });

  const setHoverDelayMs = useCallback((delayMs: number) => {
    setHoverDelayMsState(delayMs);
    if (typeof window !== 'undefined') {
      localStorage.setItem('hoverDelayMs', delayMs.toString());
    }
  }, []);

  return { hoverDelayMs, setHoverDelayMs };
}
