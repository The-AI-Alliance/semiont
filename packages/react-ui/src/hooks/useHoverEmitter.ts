'use client';

import { useRef, useCallback, useEffect } from 'react';
import type { AnnotationId } from '@semiont/core';
import { HOVER_DELAY_MS } from '@semiont/api-client';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from './useObservable';

export { HOVER_DELAY_MS } from '@semiont/api-client';

export interface HoverEmitterProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function useHoverEmitter(annotationId: AnnotationId, hoverDelayMs: number = HOVER_DELAY_MS): HoverEmitterProps {
  const session = useObservable(useSemiont().activeSession$);
  const currentHoverRef = useRef<AnnotationId | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMouseEnter = useCallback(() => {
    if (currentHoverRef.current === annotationId) return;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      currentHoverRef.current = annotationId;
      session?.client.beckon.hover(annotationId);
    }, hoverDelayMs);
  }, [annotationId, hoverDelayMs, session]);

  const onMouseLeave = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (currentHoverRef.current !== null) {
      currentHoverRef.current = null;
      session?.client.beckon.hover(null);
    }
  }, [session]);

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
