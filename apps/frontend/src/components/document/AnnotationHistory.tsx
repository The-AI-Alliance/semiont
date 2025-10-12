'use client';

import React, { useMemo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api-client';
import { type StoredEvent, isEventRelatedToAnnotation } from '@semiont/sdk';
import { HistoryEvent } from './HistoryEvent';

interface Props {
  documentId: string;
  hoveredAnnotationId?: string | null;
  onEventHover?: (annotationId: string | null) => void;
  onEventClick?: (annotationId: string | null) => void;
}

export function AnnotationHistory({ documentId, hoveredAnnotationId, onEventHover, onEventClick }: Props) {
  const t = useTranslations('AnnotationHistory');

  // Load events using React Query
  // React Query will automatically refetch when the query is invalidated by the parent
  const { data: eventsData, isLoading: loading, isError: error } = api.documents.events.useQuery(documentId);

  // Load annotations to look up text for removed/resolved events
  const { data: referencesData } = api.documents.references.useQuery(documentId);
  const { data: highlightsData } = api.documents.highlights.useQuery(documentId);
  const references = referencesData?.references || [];
  const highlights = highlightsData?.highlights || [];

  // Refs to track event elements for scrolling
  const eventRefs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sort events by oldest first (most recent at bottom)
  const events = useMemo(() => {
    if (!eventsData?.events) return [];
    return [...eventsData.events].sort((a: StoredEvent, b: StoredEvent) =>
      a.metadata.sequenceNumber - b.metadata.sequenceNumber
    );
  }, [eventsData]);

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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          {t('history')}
        </h3>
        <div className="text-sm text-gray-500 dark:text-gray-400">{t('loading')}</div>
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
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 flex flex-col h-full">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
        {t('history')}
      </h3>
      <div ref={containerRef} className="space-y-1.5 overflow-y-auto flex-1 min-h-0">
        {events.map((stored) => {
          const isRelated = hoveredAnnotationId ? isEventRelatedToAnnotation(stored, hoveredAnnotationId) : false;

          return (
            <HistoryEvent
              key={stored.event.id}
              event={stored}
              references={references}
              highlights={highlights}
              allEvents={events}
              isRelated={isRelated}
              t={t}
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