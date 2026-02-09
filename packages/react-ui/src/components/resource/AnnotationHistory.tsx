'use client';

import React, { useEffect, useRef } from 'react';
import { useTranslations } from '../../contexts/TranslationContext';
import type { RouteBuilder, LinkComponentProps } from '../../contexts/RoutingContext';
import { useResources } from '../../lib/api-hooks';
import { type StoredEvent, type ResourceUri, getAnnotationUriFromEvent } from '@semiont/api-client';
import { HistoryEvent } from './HistoryEvent';

interface Props {
  rUri: ResourceUri;
  hoveredAnnotationId?: string | null;
  onEventHover?: (annotationId: string | null) => void;
  onEventClick?: (annotationId: string | null) => void;
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
}

export function AnnotationHistory({ rUri, hoveredAnnotationId, onEventHover, onEventClick, Link, routes }: Props) {
  const t = useTranslations('AnnotationHistory');

  // API hooks
  const resources = useResources();

  // Load events using React Query
  // React Query will automatically refetch when the query is invalidated by the parent
  const { data: eventsData, isLoading: loading, isError: error } = resources.events.useQuery(rUri);

  // Load annotations to look up text for removed/resolved events (single request)
  const { data: annotationsData } = resources.annotations.useQuery(rUri);
  const annotations = annotationsData?.annotations || [];

  // Refs to track event elements for scrolling
  const eventRefs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sort events by oldest first (most recent at bottom)
  // Filter out all job events - they're represented by annotation.body.updated events instead
  const events = !eventsData?.events ? [] : [...eventsData.events]
    .filter((e: StoredEvent) => {
      const eventType = e.event.type;
      return eventType !== 'job.started' && eventType !== 'job.progress' && eventType !== 'job.completed';
    })
    .sort((a: StoredEvent, b: StoredEvent) =>
      a.metadata.sequenceNumber - b.metadata.sequenceNumber
    );

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

  if (error) {
    return null; // Silently fail
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
              key={stored.event.id}
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