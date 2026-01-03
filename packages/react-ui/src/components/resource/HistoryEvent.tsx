'use client';

import React, { useRef, useCallback } from 'react';
import type { RouteBuilder, LinkComponentProps } from '../../contexts/RoutingContext';
import {
  type StoredEvent,
  type ResourceEventType,
  formatEventType,
  getEventEmoji,
  formatRelativeTime,
  getEventDisplayContent,
  getEventEntityTypes,
  getResourceCreationDetails,
  getAnnotationUriFromEvent,
} from '@semiont/api-client';

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  event: StoredEvent;
  annotations: any[]; // Unified annotations array (all types)
  allEvents: StoredEvent[];
  isRelated: boolean;
  t: TranslateFn;
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
  onEventRef?: (annotationId: string | null, element: HTMLElement | null) => void;
  onEventClick?: (annotationId: string | null) => void;
  onEventHover?: (annotationId: string | null) => void;
}

export function HistoryEvent({
  event,
  annotations,
  allEvents,
  isRelated,
  t,
  Link,
  routes,
  onEventRef,
  onEventClick,
  onEventHover
}: Props) {
  const displayContent = getEventDisplayContent(event, annotations, allEvents);
  const annotationUri = getAnnotationUriFromEvent(event);
  const creationDetails = getResourceCreationDetails(event);
  const entityTypes = getEventEntityTypes(event);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const borderClass = isRelated
    ? 'border-l-4 border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20'
    : 'border-l-2 border-gray-200 dark:border-gray-700';

  // Handle hover on emoji icon with 300ms delay
  const handleEmojiMouseEnter = useCallback(() => {
    if (!annotationUri || !onEventHover) return;

    // Clear any existing timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }

    // Set new timeout for 300ms delay
    hoverTimeoutRef.current = setTimeout(() => {
      onEventHover(annotationUri);
    }, 300);
  }, [annotationUri, onEventHover]);

  const handleEmojiMouseLeave = useCallback(() => {
    // Clear the timeout if mouse leaves before 500ms
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }

    // Clear the hover state
    if (onEventHover) {
      onEventHover(null);
    }
  }, [onEventHover]);

  // Interactive events should be buttons for keyboard accessibility
  const EventWrapper = annotationUri ? 'button' : 'div';
  const eventWrapperProps = annotationUri ? {
    type: 'button' as const,
    onClick: () => onEventClick?.(annotationUri),
    'aria-label': t('viewAnnotation', { content: displayContent?.exact || formatEventType(event.event.type as ResourceEventType, t) }),
    className: `w-full text-left text-xs ${borderClass} pl-2 py-0.5 transition-all duration-200 hover:bg-gray-50 dark:hover:bg-gray-700/30 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset`
  } : {
    className: `text-xs ${borderClass} pl-2 py-0.5`
  };

  return (
    <EventWrapper
      ref={(el: HTMLElement | null) => {
        if (onEventRef) {
          onEventRef(annotationUri, el);
        }
      }}
      {...eventWrapperProps}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="text-sm cursor-pointer"
          onMouseEnter={handleEmojiMouseEnter}
          onMouseLeave={handleEmojiMouseLeave}
        >
          {getEventEmoji(event.event.type as ResourceEventType, event.event.payload)}
        </span>
        {displayContent ? (
          displayContent.isTag ? (
            <span className="inline-flex items-center px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded text-[11px] font-medium">
              {displayContent.exact}
            </span>
          ) : displayContent.isQuoted ? (
            <span className="font-medium text-gray-900 dark:text-gray-100 line-clamp-1 italic">
              &ldquo;{displayContent.exact}&rdquo;
            </span>
          ) : (
            <span className="font-medium text-gray-900 dark:text-gray-100 line-clamp-1">
              {displayContent.exact}
            </span>
          )
        ) : (
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {formatEventType(event.event.type as ResourceEventType, t, event.event.payload)}
          </span>
        )}
        <span className="text-[10px] text-gray-500 dark:text-gray-400 ml-auto">
          {formatRelativeTime(event.event.timestamp, t)}
        </span>
      </div>
      {entityTypes.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {entityTypes.map((type) => (
            <span
              key={type}
              className="inline-flex items-center px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded text-[10px]"
            >
              {type}
            </span>
          ))}
        </div>
      )}
      {creationDetails && (
        <div className="text-[10px] text-gray-600 dark:text-gray-400 mt-0.5">
          <span className="mr-2">
            {t('user')}: <span className="font-mono">{creationDetails.userId}</span>
          </span>
          <span className="mr-2">
            {t('method')}: <span className="uppercase">{creationDetails.method}</span>
          </span>
          {creationDetails.type === 'cloned' && creationDetails.sourceDocId && (
            <Link
              href={routes.resourceDetail(creationDetails.sourceDocId)}
              className="text-blue-600 dark:text-blue-400 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {t('viewOriginal')}
            </Link>
          )}
        </div>
      )}
    </EventWrapper>
  );
}
