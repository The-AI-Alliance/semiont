/**
 * useAttentionFlow — Annotation attention / pointer coordination hook
 *
 * Manages which annotation currently has the user's attention:
 * - Hover state (hoveredAnnotationId)
 * - Hover → sparkle relay
 * - Click → focus relay
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 *
 * Note: attend:sparkle visual effect (triggerSparkleAnimation) is owned by
 * ResourceViewerPage, which subscribes to attend:sparkle and delegates to
 * ResourceAnnotationsContext. This hook emits the signal; it does not render the effect.
 *
 * @subscribes attend:hover - Sets hoveredAnnotationId; emits attend:sparkle
 * @subscribes navigation:click - Emits attend:focus (attention relay only)
 * @emits      attend:sparkle
 * @emits      attend:focus
 */

/**
 * useHoverEmitter / createHoverHandlers — annotation hover emission utilities
 *
 * Centralises two hover quality-of-life behaviours:
 *
 * 1. currentHover guard — suppresses redundant emissions when the mouse
 *    moves within the same annotation element (prevents event bus noise).
 *
 * 2. Debounce delay (HOVER_DELAY_MS) — a short timer before emitting
 *    attend:hover, so that transient pass-through movements (user dragging
 *    the mouse across the panel to reach a button elsewhere) do not trigger
 *    sparkle animations or cross-highlight effects.
 *    The delay is cancelled immediately on mouseLeave, so leaving is always instant.
 *
 * Two forms are provided:
 *
 * useHoverEmitter(annotationId)
 *   React hook. Returns { onMouseEnter, onMouseLeave } props for JSX elements.
 *   Use in panel entries (HighlightEntry, CommentEntry, …).
 *
 * createHoverHandlers(emit)
 *   Plain factory. Returns { handleMouseEnter(id), handleMouseLeave(), cleanup }.
 *   Use inside useEffect / imperative setup code where hooks cannot be called
 *   (BrowseView, CodeMirrorRenderer, AnnotationOverlay, PdfAnnotationCanvas).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useEventBus } from '../contexts/EventBusContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';

// ─── useAttentionFlow ─────────────────────────────────────────────────────────

export interface AttentionFlowState {
  hoveredAnnotationId: string | null;
}

export function useAttentionFlow(): AttentionFlowState {
  const eventBus = useEventBus();
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);

  const handleAnnotationHover = useCallback(({ annotationId }: { annotationId: string | null }) => {
    setHoveredAnnotationId(annotationId);
    if (annotationId) {
      eventBus.get('attend:sparkle').next({ annotationId });
    }
  }, []); // eventBus is stable singleton - never in deps

  const handleAnnotationClick = useCallback(({ annotationId }: { annotationId: string }) => {
    eventBus.get('attend:focus').next({ annotationId });
    // Scroll to annotation handled by BrowseView via attend:focus subscription
  }, []); // eventBus is stable singleton - never in deps

  useEventSubscriptions({
    'attend:hover': handleAnnotationHover,
    'navigation:click': handleAnnotationClick,
  });

  return { hoveredAnnotationId };
}

// ─── createHoverHandlers (use inside useEffect / imperative setup) ────────────

/** Default milliseconds the mouse must dwell before attend:hover is emitted. */
export const HOVER_DELAY_MS = 150;

type EmitHover = (annotationId: string | null) => void;

export interface HoverHandlers {
  /** Call with the annotation ID when the mouse enters an annotation element. */
  handleMouseEnter: (annotationId: string) => void;
  /** Call when the mouse leaves the annotation element. */
  handleMouseLeave: () => void;
  /** Cancel any pending timer — call in the useEffect cleanup. */
  cleanup: () => void;
}

/**
 * Creates hover handlers for imperative code (non-hook contexts).
 * @param emit - Callback to emit hover events
 * @param delayMs - Hover delay in milliseconds
 */
export function createHoverHandlers(emit: EmitHover, delayMs: number): HoverHandlers {
  let currentHover: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const handleMouseEnter = (annotationId: string) => {
    if (currentHover === annotationId) return; // already hovering this one
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      currentHover = annotationId;
      emit(annotationId);
    }, delayMs);
  };

  const handleMouseLeave = () => {
    cancelTimer();
    if (currentHover !== null) {
      currentHover = null;
      emit(null);
    }
  };

  return { handleMouseEnter, handleMouseLeave, cleanup: cancelTimer };
}

// ─── useHoverEmitter (use in JSX onMouseEnter / onMouseLeave props) ───────────

export interface HoverEmitterProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/**
 * React hook that returns onMouseEnter / onMouseLeave props for a single
 * annotation entry element.
 *
 * @param annotationId - The ID of the annotation this element represents.
 * @param hoverDelayMs - Hover delay in milliseconds (defaults to HOVER_DELAY_MS for panel entries)
 */
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
      eventBus.get('attend:hover').next({ annotationId });
    }, hoverDelayMs);
  }, [annotationId, hoverDelayMs]); // eventBus is stable singleton - never in deps

  const onMouseLeave = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (currentHoverRef.current !== null) {
      currentHoverRef.current = null;
      eventBus.get('attend:hover').next({ annotationId: null });
    }
  }, []); // eventBus is stable singleton - never in deps

  // Cleanup timer on unmount
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
