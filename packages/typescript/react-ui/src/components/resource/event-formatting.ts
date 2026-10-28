/**
 * Event Formatting Utilities
 *
 * Display and formatting utilities for resource events.
 * No React dependencies - safe to use in any JavaScript environment.
 */

import type { Annotation, StoredEventLike, TextQuoteSelector, components } from '@semiont/core';
import {
  getAnnotationIdFromEvent,
  getEntityTypes,
  getExactText,
  getTargetSelector,
  isArray,
  isObject,
  isString,
} from '@semiont/core';
import { ANNOTATORS } from '../../lib/annotation-registry';

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;
type TaggingBody = components['schemas']['TextualBody'] & { purpose: 'tagging' };

// =============================================================================
// READING A STORED EVENT'S PAYLOAD
// =============================================================================
//
// A stored event reaches the history as the wire states it: its `type` a
// string and its `payload` an open object. What is read off a payload is
// checked here, field by field, and never cast: a payload whose shape has
// moved then shows nothing, where a cast would read the wrong field and say
// so silently.

/** One item, a list, or none: what a payload's body and a target's selector each hold. */
function itemsOf(value: unknown): unknown[] {
  if (isArray(value)) return value;
  return value === undefined ? [] : [value];
}

/** A selector that quotes: the one kind that carries an annotation's text. */
function isTextQuoteSelector(value: unknown): value is TextQuoteSelector {
  return isObject(value)
    && value.type === 'TextQuoteSelector'
    && isString(value.exact)
    && (value.prefix === undefined || isString(value.prefix))
    && (value.suffix === undefined || isString(value.suffix));
}

/** A body that tags: the kind that states an entity type. */
function isTaggingBody(value: unknown): value is TaggingBody {
  return isObject(value)
    && value.type === 'TextualBody'
    && isString(value.value)
    && value.purpose === 'tagging'
    && (value.format === undefined || isString(value.format))
    && (value.language === undefined || isString(value.language));
}

/** The annotation a `mark:added` event carries, as its payload states it; null for any other event. */
function addedAnnotation(event: StoredEventLike): Record<string, unknown> | null {
  if (event.type !== 'mark:added' || !isObject(event.payload)) return null;
  return isObject(event.payload.annotation) ? event.payload.annotation : null;
}

/** The motivation of the annotation a `mark:added` payload carries. */
function addedMotivation(payload: unknown): unknown {
  return isObject(payload) && isObject(payload.annotation) ? payload.annotation.motivation : undefined;
}

/** The text an annotation quotes, read off the annotation a `mark:added` event carries. */
function addedText(event: StoredEventLike): string {
  const target = addedAnnotation(event)?.target;
  return getExactText(isObject(target) ? itemsOf(target.selector).filter(isTextQuoteSelector) : []);
}

/** A string field of a payload, or nothing. */
function stringField(payload: unknown, field: string): string | undefined {
  if (!isObject(payload)) return undefined;
  const value = payload[field];
  return isString(value) ? value : undefined;
}

// =============================================================================
// EVENT FORMATTING AND DISPLAY
// =============================================================================

/**
 * Format event type for display with i18n support
 */
export function formatEventType(type: string, t: TranslateFn, payload?: unknown): string {
  switch (type) {
    case 'yield:created':
      return t('resourceCreated');
    case 'yield:cloned':
      return t('resourceCloned');
    case 'mark:archived':
      return t('resourceArchived');
    case 'mark:unarchived':
      return t('resourceUnarchived');

    case 'mark:added': {
      const motivation = addedMotivation(payload);
      if (motivation === 'highlighting') return t('highlightAdded');
      if (motivation === 'linking') return t('referenceCreated');
      if (motivation === 'assessing') return t('assessmentAdded');
      return t('annotationAdded');
    }
    case 'mark:removed': {
      return t('annotationRemoved');
    }
    case 'mark:body-updated': {
      return t('annotationBodyUpdated');
    }

    case 'mark:entity-tag-added':
      return t('entitytagAdded');
    case 'mark:entity-tag-removed':
      return t('entitytagRemoved');

    case 'job:completed':
    case 'job:started':
    case 'job:failed':
      return t('jobEvent');

    case 'yield:representation-added':
    case 'yield:representation-removed':
      return t('representationEvent');

    default:
      return type;
  }
}

/**
 * Get emoji for event type
 * For unified annotation events, pass the payload to determine motivation
 */
export function getEventEmoji(type: string, payload?: unknown): string {
  switch (type) {
    case 'yield:created':
    case 'yield:cloned':
    case 'mark:archived':
    case 'mark:unarchived':
      return '📄';

    case 'mark:added': {
      const motivation = addedMotivation(payload);
      // Use annotation registry as single source of truth for emojis
      if (motivation === 'highlighting') return ANNOTATORS.highlight.iconEmoji || '📝';
      if (motivation === 'linking') return ANNOTATORS.reference.iconEmoji || '📝';
      if (motivation === 'assessing') return ANNOTATORS.assessment.iconEmoji || '📝';
      return '📝';
    }
    case 'mark:removed': {
      return '🗑️';
    }
    case 'mark:body-updated': {
      return '✏️';
    }

    case 'mark:entity-tag-added':
    case 'mark:entity-tag-removed':
      return '🏷️';

    case 'job:completed':
      return '🔗';  // Link emoji for linked document creation
    case 'job:started':
      return '⚙️';  // Gear for job processing
    case 'job:failed':
      return '❌';  // X mark for failed jobs

    case 'yield:representation-added':
    case 'yield:representation-removed':
      return '📄';

    default:
      return '📝';
  }
}

/**
 * Format timestamp as relative time with i18n support
 */
export function formatRelativeTime(timestamp: string, t: TranslateFn): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('justNow');
  if (diffMins < 60) return t('minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('daysAgo', { count: diffDays });

  return date.toLocaleDateString();
}

/**
 * Helper to truncate text for display
 */
function truncateText(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? trimmed.substring(0, maxLength) + '...' : trimmed;
}

/** An annotation's text as the history quotes it, or nothing when it quotes none. */
function quoted(exact: string): { exact: string; isQuoted: boolean; isTag: boolean } | null {
  return exact ? { exact: truncateText(exact), isQuoted: true, isTag: false } : null;
}

/**
 * What an event row shows of the thing the event is about: a resource's
 * name, an annotation's text, an entity type.
 *
 * An annotation is found by its id, which is a name and never a URI: one
 * that is still there in `annotations`, and a removed one by the
 * `mark:added` event in `allEvents` that carried it.
 */
export function getEventDisplayContent(
  event: StoredEventLike,
  annotations: Annotation[],
  allEvents: StoredEventLike[]
): { exact: string; isQuoted: boolean; isTag: boolean } | null {
  switch (event.type) {
    case 'yield:created':
    case 'yield:cloned': {
      const name = stringField(event.payload, 'name');
      return name === undefined ? null : { exact: name, isQuoted: false, isTag: false };
    }

    case 'mark:body-updated': {
      const id = getAnnotationIdFromEvent(event);
      const annotation = annotations.find(a => a.id === id);
      return annotation ? quoted(getExactText(getTargetSelector(annotation.target))) : null;
    }

    case 'mark:removed': {
      const id = getAnnotationIdFromEvent(event);
      const added = allEvents.find(e => e.type === 'mark:added' && getAnnotationIdFromEvent(e) === id);
      return added ? quoted(addedText(added)) : null;
    }

    case 'mark:added':
      return quoted(addedText(event));

    case 'mark:entity-tag-added':
    case 'mark:entity-tag-removed': {
      const entityType = stringField(event.payload, 'entityType');
      return entityType === undefined ? null : { exact: entityType, isQuoted: false, isTag: true };
    }

    default:
      return null;
  }
}

/**
 * The entity types of the reference a `mark:added` event adds: the values
 * of its tagging bodies. Any other annotation's tagging body states no
 * entity type (a tag's is its category), and any other event states none.
 */
export function getEventEntityTypes(event: StoredEventLike): string[] {
  const annotation = addedAnnotation(event);
  if (!annotation || annotation.motivation !== 'linking') return [];
  return getEntityTypes({ body: itemsOf(annotation.body).filter(isTaggingBody) });
}

/**
 * Resource creation details derived from a yield:created or yield:cloned
 * event. The creation kind (`type`) is read from the event channel, not
 * from a payload field.
 */
export interface ResourceCreationDetails {
  type: 'created' | 'cloned';
  sourceDocId?: string; // For cloned resources
}

/**
 * Get resource creation details from event
 */
export function getResourceCreationDetails(event: StoredEventLike): ResourceCreationDetails | null {
  if (event.type === 'yield:created') {
    return { type: 'created' };
  }

  if (event.type === 'yield:cloned') {
    const parent = stringField(event.payload, 'parentResourceId');
    return parent === undefined ? { type: 'cloned' } : { type: 'cloned', sourceDocId: parent };
  }

  return null;
}
