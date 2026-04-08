/**
 * Wire Protocol
 *
 * Events that cross HTTP boundaries — domain events delivered via SSE,
 * SSE stream payloads, and command results visible to clients.
 *
 * This is the public contract. An external client implementing an SSE
 * consumer only needs the types defined here.
 *
 * For internal actor commands, see actor-protocol.ts.
 * For frontend-only UI events, see ui-events.ts.
 */

import type { StoredEvent,
  ResourceCreatedEvent, ResourceClonedEvent, ResourceUpdatedEvent, ResourceMovedEvent,
  RepresentationAddedEvent, RepresentationRemovedEvent,
  AnnotationAddedEvent, AnnotationRemovedEvent, AnnotationBodyUpdatedEvent,
  ResourceArchivedEvent, ResourceUnarchivedEvent,
  EntityTagAddedEvent, EntityTagRemovedEvent, EntityTypeAddedEvent,
  JobStartedEvent, JobProgressEvent, JobCompletedEvent, JobFailedEvent,

} from './stored-events';
import type { components } from './types';
import type { ResourceId, AnnotationId } from './identifiers';

// ── Shared type aliases (re-exported for convenience) ────────────────────────

export type Selector =
  | components['schemas']['TextPositionSelector']
  | components['schemas']['TextQuoteSelector']
  | components['schemas']['SvgSelector']
  | components['schemas']['FragmentSelector'];

export type GatheredContext = components['schemas']['GatheredContext'];
export type YieldProgress = components['schemas']['YieldProgress'];
export type MarkProgress = components['schemas']['MarkProgress'];
export type SelectionData = components['schemas']['SelectionData'];

// ── Domain event key list ────────────────────────────────────────────────────

/** All persisted domain event type strings. Used for runtime validation. */
export const DOMAIN_EVENT_KEYS = [
  'yield:created', 'yield:cloned', 'yield:updated', 'yield:moved',
  'yield:representation-added', 'yield:representation-removed',
  'mark:added', 'mark:removed', 'mark:body-updated',
  'mark:archived', 'mark:unarchived',
  'mark:entity-tag-added', 'mark:entity-tag-removed',
  'mark:entity-type-added',
  'job:started', 'job:progress', 'job:completed', 'job:failed',
  'embedding:computed', 'embedding:deleted',
] as const;

export type DomainEventKey = typeof DOMAIN_EVENT_KEYS[number];

/**
 * Wire protocol events — crosses HTTP via SSE or is visible to API clients.
 */
export type WireProtocol = {

  // ========================================================================
  // YIELD FLOW — domain events + SSE stream + command results
  // ========================================================================

  // Domain events
  'yield:created': StoredEvent<ResourceCreatedEvent>;
  'yield:cloned': StoredEvent<ResourceClonedEvent>;
  'yield:updated': StoredEvent<ResourceUpdatedEvent>;
  'yield:moved': StoredEvent<ResourceMovedEvent>;
  'yield:representation-added': StoredEvent<RepresentationAddedEvent>;
  'yield:representation-removed': StoredEvent<RepresentationRemovedEvent>;

  // SSE stream payloads (yield-resource-stream)
  'yield:progress': YieldProgress;
  'yield:finished': YieldProgress;
  'yield:failed': components['schemas']['YieldStreamError'];

  // Command results
  'yield:create-ok': { resourceId: ResourceId; resource: components['schemas']['ResourceDescriptor'] };
  'yield:create-failed': { error: Error };
  'yield:update-ok': { resourceId: ResourceId };
  'yield:update-failed': { resourceId: ResourceId; error: Error };
  'yield:move-ok': { resourceId: ResourceId };
  'yield:move-failed': { fromUri: string; error: Error };

  // Clone command results
  'yield:clone-token-generated': { correlationId: string; response: components['schemas']['CloneResourceWithTokenResponse'] };
  'yield:clone-token-failed': { correlationId: string; error: Error };
  'yield:clone-resource-result': { correlationId: string; response: components['schemas']['GetResourceByTokenResponse'] };
  'yield:clone-resource-failed': { correlationId: string; error: Error };
  'yield:clone-created': { correlationId: string; response: { resourceId: ResourceId } };
  'yield:clone-create-failed': { correlationId: string; error: Error };

  // ========================================================================
  // MARK FLOW — domain events + SSE stream + command results
  // ========================================================================

  // Domain events
  'mark:added': StoredEvent<AnnotationAddedEvent>;
  'mark:removed': StoredEvent<AnnotationRemovedEvent>;
  'mark:body-updated': StoredEvent<AnnotationBodyUpdatedEvent>;
  'mark:entity-tag-added': StoredEvent<EntityTagAddedEvent>;
  'mark:entity-tag-removed': StoredEvent<EntityTagRemovedEvent>;
  'mark:entity-type-added': StoredEvent<EntityTypeAddedEvent>;
  'mark:archived': StoredEvent<ResourceArchivedEvent>;
  'mark:unarchived': StoredEvent<ResourceUnarchivedEvent>;

  // SSE stream payloads (annotate-*-stream)
  'mark:progress': components['schemas']['MarkProgress'];
  'mark:assist-finished': components['schemas']['MarkAssistFinished'];
  'mark:assist-failed': components['schemas']['MarkAssistFailed'];

  // Command results
  'mark:create-ok': { annotationId: AnnotationId };
  'mark:create-failed': { error: Error };
  'mark:delete-ok': { annotationId: AnnotationId };
  'mark:delete-failed': { error: Error };
  'mark:body-update-failed': { error: Error };
  'mark:entity-type-add-failed': { error: Error };

  // ========================================================================
  // BIND FLOW — SSE stream payloads + command results
  // ========================================================================

  'bind:body-updated': { annotationId: AnnotationId };
  'bind:body-update-failed': { error: Error };
  'bind:finished': components['schemas']['BindStreamFinished'];
  'bind:failed': components['schemas']['BindStreamFailed'];

  // ========================================================================
  // MATCHER FLOW — SSE stream payloads
  // ========================================================================

  'match:search-results': components['schemas']['MatchSearchResult'];
  'match:search-failed': components['schemas']['MatchSearchFailed'];

  // ========================================================================
  // GATHER FLOW — SSE stream payloads
  // ========================================================================

  'gather:annotation-progress': components['schemas']['GatherProgress'];
  'gather:annotation-finished': components['schemas']['GatherAnnotationFinished'];
  'gather:progress': components['schemas']['GatherProgress'];
  'gather:finished': components['schemas']['GatherFinished'];

  // ========================================================================
  // JOB FLOW — domain events
  // ========================================================================

  'job:started': StoredEvent<JobStartedEvent>;
  'job:progress': StoredEvent<JobProgressEvent>;
  'job:completed': StoredEvent<JobCompletedEvent>;
  'job:failed': StoredEvent<JobFailedEvent>;

  // Job status reads (correlation-based)
  'job:status-result': { correlationId: string; response: components['schemas']['JobStatusResponse'] };
  'job:status-failed': { correlationId: string; error: Error };

  // Embedding events are defined in actor-protocol.ts — the Smelter emits
  // the flat command shape; appendEvent publishes StoredEvent on the same channel.
  // Keeping them in one place avoids an intersection conflict.

  // ========================================================================
  // SSE infrastructure
  // ========================================================================

  'stream-connected': Record<string, never>;
};
