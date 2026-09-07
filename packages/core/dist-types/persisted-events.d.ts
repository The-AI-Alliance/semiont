/**
 * Persisted Events
 *
 * The event types that get appended to the JSONL event log.
 * Each maps a type string to its OpenAPI payload schema.
 * The PersistedEvent union derives from this catalog.
 */
import type { components } from './types';
import type { AnnotationId, ResourceId } from './identifiers';
import type { Annotation } from './annotation-types';
import type { EventBase } from './event-base';
type AnnotationAddedPayload = components['schemas']['AnnotationAddedPayload'] & {
    annotation: Annotation;
};
type AnnotationRemovedPayload = components['schemas']['AnnotationRemovedPayload'] & {
    annotationId: AnnotationId;
};
type AnnotationBodyUpdatedPayload = components['schemas']['AnnotationBodyUpdatedPayload'] & {
    annotationId: AnnotationId;
};
/**
 * Maps each persisted event type string to its OpenAPI payload schema.
 * Single source of truth for "what events get written to the log."
 */
type PersistedEventCatalog = {
    'yield:created': components['schemas']['ResourceCreatedPayload'];
    'yield:cloned': components['schemas']['ResourceClonedPayload'];
    'yield:updated': components['schemas']['ResourceUpdatedPayload'];
    'yield:moved': components['schemas']['ResourceMovedPayload'];
    'yield:representation-added': components['schemas']['RepresentationAddedPayload'];
    'yield:representation-removed': components['schemas']['RepresentationRemovedPayload'];
    'mark:added': AnnotationAddedPayload;
    'mark:removed': AnnotationRemovedPayload;
    'mark:body-updated': AnnotationBodyUpdatedPayload;
    'mark:archived': components['schemas']['ResourceArchivedPayload'];
    'mark:unarchived': components['schemas']['ResourceUnarchivedPayload'];
    'mark:entity-tag-added': components['schemas']['EntityTagChangedPayload'];
    'mark:entity-tag-removed': components['schemas']['EntityTagChangedPayload'];
    'frame:entity-type-added': components['schemas']['EntityTypeAddedPayload'];
    'frame:tag-schema-added': components['schemas']['TagSchemaAddedPayload'];
    'job:started': components['schemas']['JobStartedPayload'];
    'job:completed': components['schemas']['JobCompletedPayload'];
    'job:failed': components['schemas']['JobFailedPayload'];
};
/** System event types — persisted events that have no resourceId. */
type SystemEventType = 'frame:entity-type-added' | 'frame:tag-schema-added';
/** Extract the concrete persisted event type for a given type string. */
export type EventOfType<K extends keyof PersistedEventCatalog> = K extends SystemEventType ? EventBase & {
    type: K;
    payload: PersistedEventCatalog[K];
} : EventBase & {
    type: K;
    resourceId: ResourceId;
    payload: PersistedEventCatalog[K];
};
/** The union of all persisted event types. Discriminated on `type`. */
export type PersistedEvent = {
    [K in keyof PersistedEventCatalog]: EventOfType<K>;
}[keyof PersistedEventCatalog];
export type PersistedEventType = PersistedEvent['type'];
/**
 * Runtime list of every persisted event type.
 *
 * Single source of truth for code that needs to enumerate event types at
 * runtime — most importantly the per-resource `events-stream` SSE route,
 * which subscribes to all of them. The exhaustiveness check below makes
 * it impossible to add a new member to `PersistedEventCatalog` without
 * also adding it here: forgetting fails to typecheck rather than silently
 * dropping the event from the events-stream.
 */
export declare const PERSISTED_EVENT_TYPES: readonly ["yield:created", "yield:cloned", "yield:updated", "yield:moved", "yield:representation-added", "yield:representation-removed", "mark:added", "mark:removed", "mark:body-updated", "mark:archived", "mark:unarchived", "mark:entity-tag-added", "mark:entity-tag-removed", "frame:entity-type-added", "frame:tag-schema-added", "job:started", "job:completed", "job:failed"];
/** Input type for appendEvent — PersistedEvent without id/timestamp (assigned at persistence time). */
export type EventInput = Omit<PersistedEvent, 'id' | 'timestamp'>;
export {};
