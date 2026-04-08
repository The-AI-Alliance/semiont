/**
 * Actor Protocol
 *
 * Internal commands and reads between actors on the EventBus.
 * Never crosses HTTP — stays within the make-meaning service.
 *
 * For wire protocol events, see wire-protocol.ts.
 * For frontend-only UI events, see ui-events.ts.
 */

import type { BodyOperation } from './stored-events';
import type { components } from './types';
import type { ResourceId, AnnotationId, UserId } from './identifiers';
import type { JobId } from './branded-types';
import type { CreationMethod } from './creation-methods';
import type { GatheredContext } from './wire-protocol';

type Annotation = components['schemas']['Annotation'];

/**
 * Internal actor protocol — commands and reads between actors.
 *
 * Organized by flow (verb), then by category within each flow:
 * - Commands (requests to actors)
 * - Reads (correlation-based request/response)
 */
export type ActorProtocol = {

  // ========================================================================
  // YIELD FLOW — resource creation, update, move, clone commands
  // ========================================================================

  'yield:request': {
    annotationId: AnnotationId;
    resourceId: ResourceId;
    options: {
      title: string;
      prompt?: string;
      language?: string;
      temperature?: number;
      maxTokens?: number;
      context: GatheredContext;
      storageUri: string;
    };
  };

  'yield:create': {
    name: string;
    content?: Buffer;
    storageUri?: string;
    contentChecksum?: string;
    format: components['schemas']['ContentFormat'];
    userId: UserId;
    language?: string;
    entityTypes?: string[];
    creationMethod?: CreationMethod;
    isDraft?: boolean;
    generatedFrom?: { resourceId: string; annotationId: string };
    generationPrompt?: string;
    generator?: components['schemas']['Agent'] | components['schemas']['Agent'][];
    noGit?: boolean;
  };

  'yield:update': {
    resourceId: ResourceId;
    storageUri: string;
    content?: Buffer;
    contentChecksum: string;
    userId: UserId;
    noGit?: boolean;
  };

  'yield:mv': {
    fromUri: string;
    toUri: string;
    userId: UserId;
    noGit?: boolean;
  };

  'yield:clone': void;

  // Clone token operations (CloneTokenManager handles these)
  'yield:clone-token-requested': {
    correlationId: string;
    resourceId: ResourceId;
  };
  'yield:clone-resource-requested': {
    correlationId: string;
    token: string;
  };
  'yield:clone-create': {
    correlationId: string;
    token: string;
    name: string;
    content: string;
    userId: UserId;
    archiveOriginal?: boolean;
  };

  // ========================================================================
  // MARK FLOW — annotation CRUD commands, entity type commands
  // ========================================================================

  'mark:create': {
    annotation: Annotation;
    userId: UserId;
    resourceId: ResourceId;
  };
  'mark:delete': { annotationId: AnnotationId; userId?: UserId; resourceId?: ResourceId };
  'mark:update-body': {
    annotationId: AnnotationId;
    userId: UserId;
    resourceId: ResourceId;
    operations: BodyOperation[];
  };

  // Archive/unarchive commands
  // Frontend emits void; backend route enriches with userId + resourceId + storageUri
  'mark:archive': void | { userId: UserId; resourceId?: ResourceId; storageUri?: string; keepFile?: boolean; noGit?: boolean };
  'mark:unarchive': void | { userId: UserId; resourceId?: ResourceId; storageUri?: string };

  // Entity type commands
  'mark:update-entity-types': {
    resourceId: ResourceId;
    userId: UserId;
    currentEntityTypes: string[];
    updatedEntityTypes: string[];
  };
  'mark:add-entity-type': {
    tag: string;
    userId: UserId;
  };

  // ========================================================================
  // BIND FLOW — reference linking commands
  // ========================================================================

  'bind:initiate': {
    annotationId: AnnotationId;
    resourceId: ResourceId;
    defaultTitle: string;
    entityTypes: string[];
  };
  'bind:update-body': {
    annotationId: AnnotationId;
    resourceId: ResourceId;
    userId?: UserId;
    operations: Array<{
      op: 'add' | 'remove' | 'replace';
      item?: components['schemas']['AnnotationBody'];
      oldItem?: components['schemas']['AnnotationBody'];
      newItem?: components['schemas']['AnnotationBody'];
    }>;
  };

  // ========================================================================
  // MATCHER FLOW — search commands
  // ========================================================================

  'match:search-requested': {
    correlationId: string;
    referenceId: string;
    context: GatheredContext;
    limit?: number;
    useSemanticScoring?: boolean;
  };

  // ========================================================================
  // GATHER FLOW — context gathering commands and reads
  // ========================================================================

  'gather:requested': {
    correlationId: string;
    annotationId: AnnotationId;
    resourceId: ResourceId;
    options?: {
      includeSourceContext?: boolean;
      includeTargetContext?: boolean;
      contextWindow?: number;
    };
  };
  'gather:complete': {
    correlationId: string;
    annotationId: AnnotationId;
    response: components['schemas']['AnnotationLLMContextResponse'];
  };
  'gather:failed': {
    correlationId: string;
    annotationId: AnnotationId;
    error: Error;
  };

  'gather:resource-requested': {
    correlationId: string;
    resourceId: ResourceId;
    options: {
      depth: number;
      maxResources: number;
      includeContent: boolean;
      includeSummary: boolean;
    };
  };
  'gather:resource-complete': {
    correlationId: string;
    resourceId: ResourceId;
    response: components['schemas']['ResourceLLMContextResponse'];
  };
  'gather:resource-failed': {
    correlationId: string;
    resourceId: ResourceId;
    error: Error;
  };

  // ========================================================================
  // BROWSE FLOW — knowledge base reads (correlation-based)
  // ========================================================================

  'browse:resource-requested': { correlationId: string; resourceId: ResourceId };
  'browse:resource-result': { correlationId: string; response: components['schemas']['GetResourceResponse'] };
  'browse:resource-failed': { correlationId: string; error: Error };

  'browse:resources-requested': {
    correlationId: string;
    search?: string;
    archived?: boolean;
    entityType?: string;
    offset?: number;
    limit?: number;
  };
  'browse:resources-result': { correlationId: string; response: components['schemas']['ListResourcesResponse'] };
  'browse:resources-failed': { correlationId: string; error: Error };

  'browse:annotations-requested': { correlationId: string; resourceId: ResourceId };
  'browse:annotations-result': { correlationId: string; response: components['schemas']['GetAnnotationsResponse'] };
  'browse:annotations-failed': { correlationId: string; error: Error };

  'browse:annotation-requested': { correlationId: string; resourceId: ResourceId; annotationId: AnnotationId };
  'browse:annotation-result': { correlationId: string; response: components['schemas']['GetAnnotationResponse'] };
  'browse:annotation-failed': { correlationId: string; error: Error };

  'browse:events-requested': { correlationId: string; resourceId: ResourceId; type?: string; userId?: string; limit?: number };
  'browse:events-result': { correlationId: string; response: components['schemas']['GetEventsResponse'] };
  'browse:events-failed': { correlationId: string; error: Error };

  'browse:annotation-history-requested': { correlationId: string; resourceId: ResourceId; annotationId: AnnotationId };
  'browse:annotation-history-result': { correlationId: string; response: components['schemas']['GetAnnotationHistoryResponse'] };
  'browse:annotation-history-failed': { correlationId: string; error: Error };

  'browse:referenced-by-requested': { correlationId: string; resourceId: ResourceId; motivation?: string };
  'browse:referenced-by-result': { correlationId: string; response: components['schemas']['GetReferencedByResponse'] };
  'browse:referenced-by-failed': { correlationId: string; error: Error };

  'browse:entity-types-requested': { correlationId: string };
  'browse:entity-types-result': { correlationId: string; response: components['schemas']['GetEntityTypesResponse'] };
  'browse:entity-types-failed': { correlationId: string; error: Error };

  'browse:directory-requested': { correlationId: string; path: string; sort?: 'name' | 'mtime' | 'annotationCount' };
  'browse:directory-result': { correlationId: string; response: { path: string; entries: components['schemas']['DirectoryEntry'][] } };
  'browse:directory-failed': { correlationId: string; path: string; error: Error };

  // ========================================================================
  // JOB FLOW — worker commands
  // ========================================================================

  'job:start': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: components['schemas']['JobType'];
  };
  'job:report-progress': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: components['schemas']['JobType'];
    percentage: number;
    progress?: Record<string, unknown>;
  };
  'job:complete': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: components['schemas']['JobType'];
    result?: Record<string, unknown>;
  };
  'job:fail': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: components['schemas']['JobType'];
    error: string;
  };

  'job:queued': { jobId: string; jobType: string; resourceId: string };
  'job:cancel-requested': { jobType: 'annotation' | 'generation' };
  'job:status-requested': { correlationId: string; jobId: JobId };

  // ========================================================================
  // EMBEDDING FLOW — Smelter actor commands
  // ========================================================================

  'embedding:computed': {
    resourceId: ResourceId;
    annotationId?: AnnotationId;
    chunkIndex: number;
    chunkText: string;
    embedding: number[];
    model: string;
    dimensions: number;
  };

  'embedding:deleted': {
    resourceId: ResourceId;
    annotationId?: AnnotationId;
  };
};
