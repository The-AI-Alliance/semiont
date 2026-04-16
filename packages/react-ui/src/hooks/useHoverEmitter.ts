'use client';

import { useRef, useCallback, useEffect } from 'react';
import { HOVER_DELAY_MS } from '@semiont/api-client';
import { useEventBus } from '../contexts/EventBusContext';

export { HOVER_DELAY_MS } from '@semiont/api-client';

export interface HoverEmitterProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function useHoverEmitter(annotationId: string, hoverDelayMs: number = HOVER_DELAY_MS): HoverEmitterProps {
  const eventBus = useEventBus();
  const currentHoverRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMouseEnter = useCallback(() => {
    if (currentHoverRef.current === annotationId) return;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      currentHoverRef.current = annotationId;
      eventBus.get('beckon:hover').next({ annotationId });
    }, hoverDelayMs);
  }, [annotationId, hoverDelayMs]);

  const onMouseLeave = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (currentHoverRef.current !== null) {
      currentHoverRef.current = null;
      eventBus.get('beckon:hover').next({ annotationId: null });
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return { onMouseEnter, onMouseLeave };
}
