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
    className: 'semiont-history-event',
    'data-related': isRelated ? 'true' : 'false',
    'data-interactive': 'true'
  } : {
    className: 'semiont-history-event',
    'data-related': isRelated ? 'true' : 'false'
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
      <div className="semiont-history-event__content">
        <span
          className="semiont-history-event__emoji"
          onMouseEnter={handleEmojiMouseEnter}
          onMouseLeave={handleEmojiMouseLeave}
        >
          {getEventEmoji(event.event.type as ResourceEventType, event.event.payload)}
        </span>
        {displayContent ? (
          displayContent.isTag ? (
            <span className="semiont-history-event__tag">
              {displayContent.exact}
            </span>
          ) : displayContent.isQuoted ? (
            <span className="semiont-history-event__text semiont-history-event__text--quoted">
              &ldquo;{displayContent.exact}&rdquo;
            </span>
          ) : (
            <span className="semiont-history-event__text">
              {displayContent.exact}
            </span>
          )
        ) : (
          <span className="semiont-history-event__text">
            {formatEventType(event.event.type as ResourceEventType, t, event.event.payload)}
          </span>
        )}
        {event.event.userId && (
          <span className="semiont-history-event__user">
            {event.event.userId}
          </span>
        )}
        <span className="semiont-history-event__timestamp">
          {formatRelativeTime(event.event.timestamp, t)}
        </span>
      </div>
      {entityTypes.length > 0 && (
        <div className="semiont-history-event__entity-types">
          {entityTypes.map((type) => (
            <span
              key={type}
              className="semiont-tag semiont-tag--small"
              data-variant="blue"
            >
              {type}
            </span>
          ))}
        </div>
      )}
      {creationDetails && (
        <div className="semiont-history-event__details">
          <span className="semiont-history-event__detail">
            {t('user')}: <span className="semiont-history-event__detail-value">{creationDetails.userId}</span>
          </span>
          <span className="semiont-history-event__detail">
            {t('method')}: <span className="semiont-history-event__detail-value semiont-history-event__detail-value--uppercase">{creationDetails.method}</span>
          </span>
          {creationDetails.type === 'cloned' && creationDetails.sourceDocId && (
            <Link
              href={routes.resourceDetail(creationDetails.sourceDocId)}
              className="semiont-history-event__link"
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
