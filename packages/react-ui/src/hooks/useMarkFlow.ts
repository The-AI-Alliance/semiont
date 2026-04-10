/**
 * useMarkFlow - Annotation state management hook
 *
 * Bridges EventBus commands to namespace API methods for annotation CRUD
 * and AI assist. Manages UI state (pendingAnnotation, assistingMotivation,
 * progress) via EventBus subscriptions — the React-specific portion.
 *
 * The FlowEngine's HTTP bridging role is replaced by namespace methods:
 * - mark:submit → client.mark.annotation()
 * - mark:delete → client.mark.delete()
 * - mark:assist-request → client.mark.assist() (Observable)
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Motivation, ResourceId, Selector } from '@semiont/core';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useEventBus } from '../contexts/EventBusContext';
import { useApiClient } from '../contexts/ApiClientContext';
import type { MarkProgress } from '@semiont/core';
import type { EventMap } from '@semiont/core';
import { useToast } from '../components/Toast';

type SelectionData = EventMap['mark:select-comment'];

interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface MarkFlowState {
  pendingAnnotation: PendingAnnotation | null;
  assistingMotivation: Motivation | null;
  progress: MarkProgress | null;
  assistStreamRef: React.MutableRefObject<AbortController | null>;
}

export function useMarkFlow(rUri: ResourceId): MarkFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();
  const { showSuccess, showError, showInfo } = useToast();

  // ── Manual annotation state ───────────────────────────────────────────────

  const [pendingAnnotation, setPendingAnnotation] = useState<PendingAnnotation | null>(null);

  const selectionToSelector = useCallback((selection: SelectionData): Selector | Selector[] => {
    if (selection.svgSelector) return { type: 'SvgSelector', value: selection.svgSelector };
    if (selection.fragmentSelector) {
      const selectors: Selector[] = [{ type: 'FragmentSelector', value: selection.fragmentSelector, ...(selection.conformsTo && { conformsTo: selection.conformsTo }) }];
      if (selection.exact) selectors.push({ type: 'TextQuoteSelector', exact: selection.exact, ...(selection.prefix && { prefix: selection.prefix }), ...(selection.suffix && { suffix: selection.suffix }) });
      return selectors;
    }
    return { type: 'TextQuoteSelector', exact: selection.exact, ...(selection.prefix && { prefix: selection.prefix }), ...(selection.suffix && { suffix: selection.suffix }) };
  }, []);

  const handleAnnotationRequested = useCallback((pending: PendingAnnotation) => {
    const MOTIVATION_TO_TAB: Record<Motivation, string> = { highlighting: 'annotations', commenting: 'annotations', assessing: 'annotations', tagging: 'annotations', linking: 'annotations' };
    eventBus.get('browse:panel-open').next({ panel: MOTIVATION_TO_TAB[pending.motivation] || 'annotations' });
    setPendingAnnotation(pending);
  }, []);

  // ── AI-assisted annotation state ──────────────────────────────────────────

  const [assistingMotivation, setAssistingMotivation] = useState<Motivation | null>(null);
  const [progress, setProgress] = useState<MarkProgress | null>(null);
  const assistStreamRef = useRef<AbortController | null>(null);
  const progressDismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAnnotationComplete = useCallback((event: EventMap['mark:assist-finished']) => {
    setAssistingMotivation(prev => (!event.motivation || event.motivation !== prev) ? prev : null);
    showSuccess('Annotation complete');
    if (progressDismissTimeoutRef.current) clearTimeout(progressDismissTimeoutRef.current);
    progressDismissTimeoutRef.current = setTimeout(() => { setProgress(null); progressDismissTimeoutRef.current = null; }, 5000);
  }, [showSuccess]);

  const handleAnnotationFailed = useCallback((event: EventMap['mark:assist-failed']) => {
    if (progressDismissTimeoutRef.current) { clearTimeout(progressDismissTimeoutRef.current); progressDismissTimeoutRef.current = null; }
    setAssistingMotivation(null);
    setProgress(null);
    showError(event.message || 'Annotation failed');
  }, [showError]);

  useEventSubscriptions({
    'mark:requested': handleAnnotationRequested,
    'mark:select-comment': (s) => handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'commenting' }),
    'mark:select-tag': (s) => handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'tagging' }),
    'mark:select-assessment': (s) => handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'assessing' }),
    'mark:select-reference': (s) => handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'linking' }),
    'mark:cancel-pending': () => setPendingAnnotation(null),
    'mark:create-ok': () => setPendingAnnotation(null),

    // Bridge mark:submit to client.mark.annotation()
    'mark:submit': async (event) => {
      try {
        const result = await client.mark.annotation(rUri, {
          motivation: event.motivation,
          target: { source: rUri, selector: event.selector as Selector },
          body: event.body,
        });
        eventBus.get('mark:create-ok').next({ annotationId: result.annotationId });
      } catch (error) {
        eventBus.get('mark:create-failed').next({ message: error instanceof Error ? error.message : String(error) });
      }
    },

    // Bridge mark:delete to client.mark.delete()
    'mark:delete': async (event) => {
      try {
        await client.mark.delete(rUri, event.annotationId as Parameters<typeof client.mark.delete>[1]);
        eventBus.get('mark:delete-ok').next({ annotationId: event.annotationId });
      } catch (error) {
        eventBus.get('mark:delete-failed').next({ message: error instanceof Error ? error.message : String(error) });
      }
    },

    // Bridge mark:assist-request to client.mark.assist() Observable
    'mark:assist-request': (event) => {
      if (progressDismissTimeoutRef.current) { clearTimeout(progressDismissTimeoutRef.current); progressDismissTimeoutRef.current = null; }
      setAssistingMotivation(event.motivation);
      setProgress(null);

      client.mark.assist(rUri, event.motivation, event.options).subscribe({
        next: (p) => setProgress(p as MarkProgress),
        error: (err) => handleAnnotationFailed({ resourceId: rUri as string, message: err.message }),
        complete: () => {}, // handled by mark:assist-finished EventBus subscription
      });
    },

    'mark:progress': (chunk: MarkProgress) => setProgress(chunk),
    'mark:assist-finished': handleAnnotationComplete,
    'mark:assist-failed': handleAnnotationFailed,
    'mark:progress-dismiss': () => {
      if (progressDismissTimeoutRef.current) { clearTimeout(progressDismissTimeoutRef.current); progressDismissTimeoutRef.current = null; }
      setProgress(null);
    },
    'mark:assist-cancelled': () => showInfo('Annotation cancelled'),
    'mark:create-failed': ({ message }) => showError(`Failed to create annotation: ${message}`),
    'mark:delete-failed': ({ message }) => showError(`Failed to delete annotation: ${message}`),
  });

  useEffect(() => () => { if (progressDismissTimeoutRef.current) clearTimeout(progressDismissTimeoutRef.current); }, []);

  return { pendingAnnotation, assistingMotivation, progress, assistStreamRef };
}
