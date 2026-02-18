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
 * Note: annotation:sparkle visual effect (triggerSparkleAnimation) is owned by
 * ResourceViewerPage, which subscribes to annotation:sparkle and delegates to
 * ResourceAnnotationsContext. This hook emits the signal; it does not render the effect.
 *
 * @subscribes annotation:hover - Sets hoveredAnnotationId; emits annotation:sparkle
 * @subscribes annotation:click - Emits annotation:focus (attention relay only)
 * @emits      annotation:sparkle
 * @emits      annotation:focus
 */

import { useState, useCallback } from 'react';
import { useEventBus } from '../contexts/EventBusContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';

export interface AttentionFlowState {
  hoveredAnnotationId: string | null;
}

export function useAttentionFlow(): AttentionFlowState {
  const eventBus = useEventBus();
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);

  const handleAnnotationHover = useCallback(({ annotationId }: { annotationId: string | null }) => {
    setHoveredAnnotationId(annotationId);
    if (annotationId) {
      eventBus.emit('annotation:sparkle', { annotationId });
    }
  }, []); // eventBus is stable singleton - never in deps

  const handleAnnotationClick = useCallback(({ annotationId }: { annotationId: string }) => {
    eventBus.emit('annotation:focus', { annotationId });
    // Scroll to annotation handled by BrowseView via annotation:focus subscription
  }, []); // eventBus is stable singleton - never in deps

  useEventSubscriptions({
    'annotation:hover': handleAnnotationHover,
    'annotation:click': handleAnnotationClick,
  });

  return { hoveredAnnotationId };
}
