'use client';

import React from 'react';
import type { StoredEvent } from '@semiont/core-types';
import {
  formatEventType,
  getEventEmoji,
  formatRelativeTime,
  getEventDisplayContent,
  getEventEntityTypes,
  getDocumentCreationDetails,
  getAnnotationIdFromEvent,
} from '@/lib/annotation-history-utils';

interface Props {
  event: StoredEvent;
  references: any[];
  highlights: any[];
  allEvents: StoredEvent[];
  isRelated: boolean;
  onEventRef?: (annotationId: string | null, element: HTMLElement | null) => void;
  onEventClick?: (annotationId: string | null) => void;
  onEventHover?: (annotationId: string | null) => void;
}

export function HistoryEvent({
  event,
  references,
  highlights,
  allEvents,
  isRelated,
  onEventRef,
  onEventClick,
  onEventHover
}: Props) {
  const displayContent = getEventDisplayContent(event, references, highlights, allEvents);
  const annotationId = getAnnotationIdFromEvent(event);
  const creationDetails = getDocumentCreationDetails(event);
  const entityTypes = getEventEntityTypes(event);

  const borderClass = isRelated
    ? 'border-l-4 border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20'
    : 'border-l-2 border-gray-200 dark:border-gray-700';

  // Interactive events should be buttons for keyboard accessibility
  const EventWrapper = annotationId ? 'button' : 'div';
  const eventWrapperProps = annotationId ? {
    type: 'button' as const,
    onClick: () => onEventClick?.(annotationId),
    onMouseEnter: () => onEventHover?.(annotationId),
    onMouseLeave: () => onEventHover?.(null),
    'aria-label': `View annotation: ${displayContent?.text || formatEventType(event.event.type)}`,
    className: `w-full text-left text-xs ${borderClass} pl-2 py-0.5 transition-all duration-200 hover:bg-gray-50 dark:hover:bg-gray-700/30 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset`
  } : {
    className: `text-xs ${borderClass} pl-2 py-0.5`
  };

  return (
    <EventWrapper
      ref={(el: HTMLElement | null) => {
        if (onEventRef) {
          onEventRef(annotationId, el);
        }
      }}
      {...eventWrapperProps}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-sm">{getEventEmoji(event.event.type)}</span>
        {displayContent ? (
          displayContent.isTag ? (
            <span className="inline-flex items-center px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded text-[11px] font-medium">
              {displayContent.text}
            </span>
          ) : displayContent.isQuoted ? (
            <span className="font-medium text-gray-900 dark:text-gray-100 line-clamp-1 italic">
              &ldquo;{displayContent.text}&rdquo;
            </span>
          ) : (
            <span className="font-medium text-gray-900 dark:text-gray-100 line-clamp-1">
              {displayContent.text}
            </span>
          )
        ) : (
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {formatEventType(event.event.type)}
          </span>
        )}
        <span className="text-[10px] text-gray-500 dark:text-gray-400 ml-auto">
          {formatRelativeTime(event.event.timestamp)}
        </span>
      </div>
      {entityTypes && entityTypes.length > 0 && (
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
          {creationDetails.userId && (
            <span className="mr-2">
              User: <span className="font-mono">{creationDetails.userId.substring(0, 8)}</span>
            </span>
          )}
          {creationDetails.method && (
            <span className="mr-2">
              Method: <span className="capitalize">{creationDetails.method}</span>
            </span>
          )}
          {creationDetails.sourceDocId && (
            <a
              href={`/know/document/${encodeURIComponent(creationDetails.sourceDocId)}`}
              className="text-blue-600 dark:text-blue-400 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              View original
            </a>
          )}
        </div>
      )}
    </EventWrapper>
  );
}
