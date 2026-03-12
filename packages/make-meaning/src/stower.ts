/**
 * Stower Actor
 *
 * The single write gateway to the Knowledge Base. Subscribes to command
 * events on the EventBus and translates them into domain events on the
 * EventStore + content writes to the RepresentationStore.
 *
 * From ARCHITECTURE-NEXT.md:
 * The Knowledge Base has exactly three actor interfaces:
 * - Stower (write) — this actor
 * - Gatherer (read context)
 * - Binder (read search)
 *
 * No other code should call eventStore.appendEvent() or repStore.store().
 *
 * Subscriptions:
 * - yield:create       → resource.created (+ content store)   → yield:created / yield:create-failed
 * - mark:create        → annotation.added                     → mark:created / mark:create-failed
 * - mark:delete        → annotation.removed                   → mark:deleted / mark:delete-failed
 * - mark:update-body   → annotation.body.updated              → (no result event yet)
 * - mark:archive       → resource.archived                    (resource-scoped, no result event)
 * - mark:unarchive     → resource.unarchived                  (resource-scoped, no result event)
 * - mark:add-entity-type → entitytype.added                   → mark:entity-type-added / mark:entity-type-add-failed
 * - mark:update-entity-types → entitytag.added / entitytag.removed
 * - job:start          → job.started
 * - job:report-progress → job.progress
 * - job:complete       → job.completed
 * - job:fail           → job.failed
 */

import { Subscription, from, merge } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import type { EventMap, Logger } from '@semiont/core';
import { EventBus, resourceId, uriToAnnotationId, CREATION_METHODS, generateUuid } from '@semiont/core';
import type { CreationMethod, ResourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import type { KnowledgeBase } from './knowledge-base';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface CreateResourceResult {
  resourceId: ResourceId;
  resource: ResourceDescriptor;
}

export class Stower {
  private subscription: Subscription | null = null;
  private readonly logger: Logger;

  constructor(
    private kb: KnowledgeBase,
    private publicURL: string,
    private eventBus: EventBus,
    logger: Logger,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Stower actor initialized');

    const pipe = <K extends keyof EventMap>(event: K, handler: (e: EventMap[K]) => Promise<void>) =>
      this.eventBus.get(event).pipe(concatMap((e) => from(handler(e))));

    this.subscription = merge(
      pipe('yield:create', (e) => this.handleYieldCreate(e)),
      pipe('mark:create', (e) => this.handleMarkCreate(e)),
      pipe('mark:delete', (e) => this.handleMarkDelete(e)),
      pipe('mark:update-body', (e) => this.handleMarkUpdateBody(e)),
      pipe('mark:add-entity-type', (e) => this.handleAddEntityType(e)),
      pipe('mark:archive', (e) => this.handleMarkArchive(e)),
      pipe('mark:unarchive', (e) => this.handleMarkUnarchive(e)),
      pipe('mark:update-entity-types', (e) => this.handleUpdateEntityTypes(e)),
      pipe('job:start', (e) => this.handleJobStart(e)),
      pipe('job:report-progress', (e) => this.handleJobReportProgress(e)),
      pipe('job:complete', (e) => this.handleJobComplete(e)),
      pipe('job:fail', (e) => this.handleJobFail(e)),
    ).subscribe({
      error: (err: unknown) => this.logger.error('Stower pipeline error', { error: err }),
    });
  }

  // ========================================================================
  // Event handlers
  // ========================================================================

  private async handleYieldCreate(event: EventMap['yield:create']): Promise<void> {
    try {
      const rId = resourceId(generateUuid());

      const storedRep = await this.kb.content.store(event.content, {
        mediaType: event.format,
        language: event.language || undefined,
        rel: 'original',
      });

      const validCreationMethods = Object.values(CREATION_METHODS) as string[];
      const validatedCreationMethod = event.creationMethod && validCreationMethods.includes(event.creationMethod)
        ? (event.creationMethod as CreationMethod)
        : CREATION_METHODS.API;

      await this.kb.eventStore.appendEvent({
        type: 'resource.created',
        resourceId: rId,
        userId: event.userId,
        version: 1,
        payload: {
          name: event.name,
          format: event.format,
          contentChecksum: storedRep.checksum,
          contentByteSize: storedRep.byteSize,
          creationMethod: validatedCreationMethod,
          entityTypes: event.entityTypes || [],
          language: event.language || undefined,
          isDraft: event.isDraft ?? false,
          generatedFrom: event.generatedFrom,
          generationPrompt: event.generationPrompt,
        },
      });

      const normalizedBase = this.publicURL.endsWith('/') ? this.publicURL.slice(0, -1) : this.publicURL;
      const resource: ResourceDescriptor = {
        '@context': 'https://schema.org/' as const,
        '@id': `${normalizedBase}/resources/${rId}`,
        name: event.name,
        archived: false,
        entityTypes: event.entityTypes || [],
        creationMethod: validatedCreationMethod,
        dateCreated: new Date().toISOString(),
        representations: [
          {
            mediaType: storedRep.mediaType,
            checksum: storedRep.checksum,
            byteSize: storedRep.byteSize,
            rel: 'original' as const,
            language: storedRep.language,
          },
        ],
      };

      this.eventBus.get('yield:created').next({ resourceId: rId, resource });
    } catch (error) {
      this.logger.error('Failed to create resource', { error });
      this.eventBus.get('yield:create-failed').next({
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleMarkCreate(event: EventMap['mark:create']): Promise<void> {
    // Backend/worker path: annotation and userId and resourceId are provided
    if (!event.annotation || !event.userId || !event.resourceId) {
      return; // Frontend-only event — handled by route, not Stower
    }

    try {
      this.logger.debug('Stowing annotation', { annotationId: event.annotation.id });
      await this.kb.eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: event.resourceId,
        userId: event.userId,
        version: 1,
        payload: { annotation: event.annotation },
      });
      this.eventBus.get('mark:created').next({ annotationId: uriToAnnotationId(event.annotation.id) });
    } catch (error) {
      this.logger.error('Failed to create annotation', { error });
      this.eventBus.get('mark:create-failed').next({
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleMarkDelete(event: EventMap['mark:delete']): Promise<void> {
    if (!event.userId || !event.resourceId) {
      return; // Frontend-only event — handled by route, not Stower
    }

    try {
      await this.kb.eventStore.appendEvent({
        type: 'annotation.removed',
        resourceId: event.resourceId,
        userId: event.userId,
        version: 1,
        payload: { annotationId: event.annotationId },
      });
      this.eventBus.get('mark:deleted').next({ annotationId: event.annotationId });
    } catch (error) {
      this.logger.error('Failed to delete annotation', { error });
      this.eventBus.get('mark:delete-failed').next({
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleMarkUpdateBody(event: EventMap['mark:update-body']): Promise<void> {
    try {
      const stored = await this.kb.eventStore.appendEvent({
        type: 'annotation.body.updated',
        resourceId: event.resourceId,
        userId: event.userId,
        version: 1,
        payload: { annotationId: event.annotationId, operations: event.operations },
      });
      this.eventBus.get('mark:body-updated').next(stored.event as EventMap['mark:body-updated']);
    } catch (error) {
      this.logger.error('Failed to update annotation body', { error });
      this.eventBus.get('mark:body-update-failed').next({
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleMarkArchive(event: EventMap['mark:archive']): Promise<void> {
    if (!event || typeof event !== 'object' || !('userId' in event) || !('resourceId' in event) || !event.resourceId) {
      return; // Frontend-only event (void) — not for Stower
    }
    await this.kb.eventStore.appendEvent({
      type: 'resource.archived',
      resourceId: event.resourceId,
      userId: event.userId,
      version: 1,
      payload: { reason: undefined },
    });
  }

  private async handleMarkUnarchive(event: EventMap['mark:unarchive']): Promise<void> {
    if (!event || typeof event !== 'object' || !('userId' in event) || !('resourceId' in event) || !event.resourceId) {
      return; // Frontend-only event (void) — not for Stower
    }
    await this.kb.eventStore.appendEvent({
      type: 'resource.unarchived',
      resourceId: event.resourceId,
      userId: event.userId,
      version: 1,
      payload: {},
    });
  }

  private async handleAddEntityType(event: EventMap['mark:add-entity-type']): Promise<void> {
    try {
      await this.kb.eventStore.appendEvent({
        type: 'entitytype.added',
        userId: event.userId,
        version: 1,
        payload: { entityType: event.tag },
      });
      this.eventBus.get('mark:entity-type-added').next({ tag: event.tag });
    } catch (error) {
      this.logger.error('Failed to add entity type', { error });
      this.eventBus.get('mark:entity-type-add-failed').next({
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleUpdateEntityTypes(event: EventMap['mark:update-entity-types']): Promise<void> {
    const added = event.updatedEntityTypes.filter(et => !event.currentEntityTypes.includes(et));
    const removed = event.currentEntityTypes.filter(et => !event.updatedEntityTypes.includes(et));

    for (const entityType of added) {
      await this.kb.eventStore.appendEvent({
        type: 'entitytag.added',
        resourceId: event.resourceId,
        userId: event.userId,
        version: 1,
        payload: { entityType },
      });
    }

    for (const entityType of removed) {
      await this.kb.eventStore.appendEvent({
        type: 'entitytag.removed',
        resourceId: event.resourceId,
        userId: event.userId,
        version: 1,
        payload: { entityType },
      });
    }
  }

  private async handleJobStart(event: EventMap['job:start']): Promise<void> {
    await this.kb.eventStore.appendEvent({
      type: 'job.started',
      resourceId: event.resourceId,
      userId: event.userId,
      version: 1,
      payload: { jobId: event.jobId, jobType: event.jobType },
    });
  }

  private async handleJobReportProgress(event: EventMap['job:report-progress']): Promise<void> {
    await this.kb.eventStore.appendEvent({
      type: 'job.progress',
      resourceId: event.resourceId,
      userId: event.userId,
      version: 1,
      payload: {
        jobId: event.jobId,
        jobType: event.jobType,
        percentage: event.percentage,
        progress: event.progress,
      },
    });
  }

  private async handleJobComplete(event: EventMap['job:complete']): Promise<void> {
    await this.kb.eventStore.appendEvent({
      type: 'job.completed',
      resourceId: event.resourceId,
      userId: event.userId,
      version: 1,
      payload: {
        jobId: event.jobId,
        jobType: event.jobType,
        result: event.result,
      },
    });
  }

  private async handleJobFail(event: EventMap['job:fail']): Promise<void> {
    await this.kb.eventStore.appendEvent({
      type: 'job.failed',
      resourceId: event.resourceId,
      userId: event.userId,
      version: 1,
      payload: {
        jobId: event.jobId,
        jobType: event.jobType,
        error: event.error,
      },
    });
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.logger.info('Stower actor stopped');
  }
}
