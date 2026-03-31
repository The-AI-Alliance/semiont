/**
 * useMarkFlow - Annotation state management hook
 *
 * Activates mark orchestration (CRUD + AI assist) by delegating to
 * client.flows.mark(). Manages UI state (pendingAnnotation, assistingMotivation,
 * progress) via EventBus subscriptions — the React-specific portion.
 *
 * @subscribes mark:submit, mark:delete, mark:assist-request, job:cancel-requested
 * @subscribes mark:requested, mark:select-*, mark:cancel-pending
 * @subscribes mark:progress, mark:assist-finished, mark:assist-failed
 * @returns Annotation flow state
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Motivation, ResourceId, Selector, ResourceEvent } from '@semiont/core';
import { accessToken } from '@semiont/core';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useEventBus } from '../contexts/EventBusContext';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
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
  const token = useAuthToken();
  const { showSuccess, showError, showInfo } = useToast();

  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; });

  // Activate flow engine subscription (CRUD + assist SSE)
  useEffect(() => {
    const sub = client.flows.mark(rUri, () =>
      tokenRef.current ? accessToken(tokenRef.current) : undefined
    );
    return () => sub.unsubscribe();
  }, [rUri, client]);

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

  const handleAnnotationFailed = useCallback((event: Extract<ResourceEvent, { type: 'job.failed' }>) => {
    if (progressDismissTimeoutRef.current) { clearTimeout(progressDismissTimeoutRef.current); progressDismissTimeoutRef.current = null; }
    setAssistingMotivation(null);
    setProgress(null);
    showError(event.payload.error || 'Annotation failed');
  }, [showError]);

  useEventSubscriptions({
    'mark:requested': handleAnnotationRequested,
    'mark:select-comment': (s) => handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'commenting' }),
    'mark:select-tag': (s) => handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'tagging' }),
    'mark:select-assessment': (s) => handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'assessing' }),
    'mark:select-reference': (s) => handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'linking' }),
    'mark:cancel-pending': () => setPendingAnnotation(null),
    'mark:created': () => setPendingAnnotation(null),
    'mark:assist-request': (event) => {
      if (progressDismissTimeoutRef.current) { clearTimeout(progressDismissTimeoutRef.current); progressDismissTimeoutRef.current = null; }
      setAssistingMotivation(event.motivation);
      setProgress(null);
    },
    'mark:progress': (chunk: MarkProgress) => setProgress(chunk),
    'mark:assist-finished': handleAnnotationComplete,
    'mark:assist-failed': handleAnnotationFailed,
    'mark:progress-dismiss': () => {
      if (progressDismissTimeoutRef.current) { clearTimeout(progressDismissTimeoutRef.current); progressDismissTimeoutRef.current = null; }
      setProgress(null);
    },
    'mark:assist-cancelled': () => showInfo('Annotation cancelled'),
    'mark:create-failed': ({ error }) => showError(`Failed to create annotation: ${error.message}`),
    'mark:delete-failed': ({ error }) => showError(`Failed to delete annotation: ${error.message}`),
  });

  useEffect(() => () => { if (progressDismissTimeoutRef.current) clearTimeout(progressDismissTimeoutRef.current); }, []);

  return { pendingAnnotation, assistingMotivation, progress, assistStreamRef };
}
