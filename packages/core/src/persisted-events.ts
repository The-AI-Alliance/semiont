// ⚠ GENERATED FILE — do not edit.
//
// Authority:   specs/src/bus/registry.json  (channels, payloads, operations)
// Regenerate:  node scripts/bus/generate-ts.mjs
// Go counterpart: node scripts/bus/generate-go.mjs → packages/sdk-go/bus
//
// Payload schemas themselves live in the OpenAPI components; the registry
// names which one each channel carries, and every payload type here is
// derived from that. Add or change a channel THERE.

/**
 * Persisted Events
 *
 * The event types that get appended to the JSONL event log, each with the
 * component schema of its payload. The PersistedEvent union derives from this
 * catalog.
 */

import type { components } from './types';
import type { AnnotationId, ResourceId } from './identifiers';
import type { Annotation } from './annotation-types';
import type { EventBase, Refines } from './event-base';

/**
 * Each persisted event type and the payload it carries. A `Refines` entry
 * narrows the schema's type to this layer's branded one, so consumers read
 * `payload.annotation.id` as `AnnotationId` without an upcast at every seam.
 */
type PersistedEventCatalog = {
  'yield:created': components['schemas']['ResourceCreatedPayload'];
  'yield:cloned': components['schemas']['ResourceClonedPayload'];
  'yield:updated': components['schemas']['ResourceUpdatedPayload'];
  'yield:moved': components['schemas']['ResourceMovedPayload'];
  'yield:representation-added': components['schemas']['RepresentationAddedPayload'];
  'yield:representation-removed': components['schemas']['RepresentationRemovedPayload'];
  'mark:added': Refines<components['schemas']['AnnotationAddedPayload'], components['schemas']['AnnotationAddedPayload'] & { annotation: Annotation }>;
  'mark:removed': Refines<components['schemas']['AnnotationRemovedPayload'], components['schemas']['AnnotationRemovedPayload'] & { annotationId: AnnotationId }>;
  'mark:body-updated': Refines<components['schemas']['AnnotationBodyUpdatedPayload'], components['schemas']['AnnotationBodyUpdatedPayload'] & { annotationId: AnnotationId }>;
  'mark:entity-tag-added': components['schemas']['EntityTagChangedPayload'];
  'mark:entity-tag-removed': components['schemas']['EntityTagChangedPayload'];
  'mark:archived': components['schemas']['ResourceArchivedPayload'];
  'mark:unarchived': components['schemas']['ResourceUnarchivedPayload'];
  'frame:entity-type-added': components['schemas']['EntityTypeAddedPayload'];
  'frame:tag-schema-added': components['schemas']['TagSchemaAddedPayload'];
  'person:profiled': components['schemas']['PersonProfiledPayload'];
  'job:started': components['schemas']['JobStartedPayload'];
  'job:assigned': components['schemas']['JobAssignedPayload'];
  'job:completed': components['schemas']['JobCompletedPayload'];
  'job:failed': components['schemas']['JobFailedPayload'];
};

/** System event types — persisted events that have no resourceId. */
type SystemEventType = 'frame:entity-type-added' | 'frame:tag-schema-added' | 'person:profiled';

/** Extract the concrete persisted event type for a given type string. */
export type EventOfType<K extends keyof PersistedEventCatalog> =
  K extends SystemEventType
    ? EventBase & { type: K; payload: PersistedEventCatalog[K] }
    : EventBase & { type: K; resourceId: ResourceId; payload: PersistedEventCatalog[K] };

/** The union of all persisted event types. Discriminated on `type`. */
export type PersistedEvent = {
  [K in keyof PersistedEventCatalog]: EventOfType<K>
}[keyof PersistedEventCatalog];

export type PersistedEventType = PersistedEvent['type'];

/** Every persisted event type, for code that enumerates them at runtime. */
export const PERSISTED_EVENT_TYPES = [
  'yield:created',
  'yield:cloned',
  'yield:updated',
  'yield:moved',
  'yield:representation-added',
  'yield:representation-removed',
  'mark:added',
  'mark:removed',
  'mark:body-updated',
  'mark:entity-tag-added',
  'mark:entity-tag-removed',
  'mark:archived',
  'mark:unarchived',
  'frame:entity-type-added',
  'frame:tag-schema-added',
  'person:profiled',
  'job:started',
  'job:assigned',
  'job:completed',
  'job:failed',
] as const satisfies readonly PersistedEventType[];

/** Input type for appendEvent — PersistedEvent without id/timestamp (assigned at persistence time). */
export type EventInput = Omit<PersistedEvent, 'id' | 'timestamp'>;
