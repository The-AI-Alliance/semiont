'use client';

import React, { useEffect, useRef } from 'react';
import { useTranslations } from '../../contexts/TranslationContext';
import type { RouteBuilder, LinkComponentProps } from '../../contexts/RoutingContext';
import type { Annotation } from '@semiont/core';
import { getAnnotationUriFromEvent, type StoredEventLike } from '@semiont/core';
import { HistoryEvent } from './HistoryEvent';

interface Props {
  /**
   * The resource's stored events, and how their load is going. Supplied by the
   * owner (which already holds them on its state unit) rather than fetched
   * here: a self-fetching panel can only model (value | not-yet), so a
   * terminal failure (B15) is indistinguishable from a request still in
   * flight and the panel says "Loading..." for ever.
   * See .plans/PANEL-FAILURE-STATES.md
   */
  events: StoredEventLike[];
  eventsLoading?: boolean;
  eventsError?: Error | null;
  onRetryEvents?: () => void;
  /** Annotations for the same resource — used to resolve event → annotation. */
  annotations?: Annotation[];
  hoveredAnnotationId?: string | null;
  onEventHover?: (annotationId: string | null) => void;
  onEventClick?: (annotationId: string | null) => void;
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
}

export function AnnotationHistory({
  events: eventsData,
  eventsLoading = false,
  eventsError = null,
  onRetryEvents,
  annotations = [],
  hoveredAnnotationId,
  onEventHover,
  onEventClick,
  Link,
  routes,
}: Props) {
  const t = useTranslations('AnnotationHistory');
  const loading = eventsLoading;
  const error = eventsError;

  // Refs to track event elements for scrolling
  const eventRefs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sort events by oldest first (most recent at bottom)
  // Filter out job events - they're represented by mark:body-updated events instead
  // `job:progress` is no longer a persisted event type, but logs written before it
  // was retired still hold them; naming it here keeps those out of the history.
  const events: StoredEventLike[] = eventsData
    .filter((e) => {
      return e.type !== 'job:started' && e.type !== 'job:progress' && e.type !== 'job:completed';
    })
    .sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);

  // Scroll to bottom when History is first shown or when events change
  useEffect(() => {
    if (containerRef.current && events.length > 0) {
      // Use requestAnimationFrame to ensure DOM has updated before scrolling
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      });
    }
  }, [events.length]); // Only trigger when number of events changes

  // Add visual pulse and scroll to hovered annotation's event
  useEffect(() => {
    if (!hoveredAnnotationId) return;

    const eventElement = eventRefs.current.get(hoveredAnnotationId);

    if (eventElement && containerRef.current) {
      // Scroll the event into view
      eventElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      // Add a visual pulse to the history event
      eventElement.classList.add('bg-blue-100', 'dark:bg-blue-900/30');
      setTimeout(() => {
        eventElement.classList.remove('bg-blue-100', 'dark:bg-blue-900/30');
      }, 1500);
    }
  }, [hoveredAnnotationId]);

  if (error) {
    // Previously `return null` behind a hard-coded `const error = false`, so
    // this branch was unreachable and a failed load simply hung in `loading`.
    return (
      <div className="semiont-history-panel">
        <h3 className="semiont-history-panel__title">
          {t('history')}
        </h3>
        <p className="semiont-history-panel__error">
          {t('failed')}
          {onRetryEvents && (
            <>
              {' '}
              <button type="button" onClick={onRetryEvents} className="semiont-panel__inline-action">
                {t('retry')}
              </button>
            </>
          )}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="semiont-history-panel">
        <h3 className="semiont-history-panel__title">
          {t('history')}
        </h3>
        <div className="semiont-history-panel__loading">{t('loading')}</div>
      </div>
    );
  }

  if (events.length === 0) {
    return null; // No history to show
  }

  return (
    <div className="semiont-history-panel">
      <h3 className="semiont-history-panel__title">
        {t('history')}
      </h3>
      <div ref={containerRef} className="semiont-history-panel__list">
        {events.map((stored) => {
          // Check if event is related to the hovered annotation
          const isRelated = hoveredAnnotationId ? (() => {
            const eventUri = getAnnotationUriFromEvent(stored);
            if (!eventUri) return false;
            // Direct comparison - both should be full URIs
            return eventUri === hoveredAnnotationId;
          })() : false;

          return (
            <HistoryEvent
              key={stored.id}
              event={stored}
              annotations={annotations}
              allEvents={events}
              isRelated={isRelated}
              t={t}
              Link={Link}
              routes={routes}
              onEventRef={(annotationId, el) => {
                if (el && annotationId) {
                  eventRefs.current.set(annotationId, el);
                } else if (!el && annotationId) {
                  eventRefs.current.delete(annotationId);
                }
              }}
              {...(onEventClick && { onEventClick })}
              {...(onEventHover && { onEventHover })}
            />
          );
        })}
      </div>
    </div>
  );
}