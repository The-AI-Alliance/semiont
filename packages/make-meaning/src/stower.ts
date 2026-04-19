/**
 * Stower Actor
 *
 * The single write gateway to the Knowledge Base. Subscribes to command
 * events on the EventBus and translates them into domain events on the
 * EventStore + content writes to the RepresentationStore.
 *
 * From ARCHITECTURE.md:
 * The Knowledge Base has exactly three actor interfaces:
 * - Stower (write) — this actor
 * - Gatherer (read context)
 * - Matcher (read search)
 *
 * No other code should call eventStore.appendEvent() or repStore.store().
 *
 * Subscriptions:
 * - yield:create       → resource.created (+ content store)   → yield:created / yield:create-failed
 * - yield:update       → resource.updated (+ content store)   → yield:updated / yield:update-failed
 * - yield:mv           → resource.moved (+ working tree move) → yield:moved / yield:move-failed
 * - mark:create        → annotation.added                     → mark:created / mark:create-failed
 * - mark:delete        → annotation.removed                   → mark:deleted / mark:delete-failed
 * - mark:update-body   → annotation.body.updated              → (no result event yet)
 * - mark:archive       → resource.archived (+ file removal)   (resource-scoped, no result event)
 * - mark:unarchive     → resource.unarchived                  (resource-scoped, no result event)
 * - mark:add-entity-type → entitytype.added                   → mark:entity-type-added / mark:entity-type-add-failed
 * - mark:update-entity-types → entitytag.added / entitytag.removed
 * - job:start          → job.started
 * - job:report-progress → job.progress
 * - job:complete       → job.completed
 * - job:fail           → job.failed
 */

import { promises as fs } from 'fs';
import { Subscription, from, merge } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import type { EventMap, Logger } from '@semiont/core';
import { EventBus, resourceId, userId as makeUserId, CREATION_METHODS, generateUuid } from '@semiont/core';
import type { CreationMethod, ResourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import { resolveStorageUri } from '@semiont/event-sourcing';
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
      pipe('yield:update', (e) => this.handleYieldUpdate(e)),
      pipe('yield:mv', (e) => this.handleYieldMv(e)),
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

      // Content is already on disk at storageUri (callers write before emitting).
      // Register verifies the file exists and validates the checksum.
      const stored = await this.kb.content.register(event.storageUri, event.contentChecksum, { noGit: event.noGit });
      const checksum = stored.checksum;
      const byteSize = event.byteSize;

      const validCreationMethods = Object.values(CREATION_METHODS) as string[];
      const validatedCreationMethod = event.creationMethod && validCreationMethods.includes(event.creationMethod)
        ? (event.creationMethod as CreationMethod)
        : CREATION_METHODS.API;

      // generatedFrom on the bus command has optional fields; the domain event requires both
      const generatedFrom = event.generatedFrom?.resourceId && event.generatedFrom?.annotationId
        ? { resourceId: event.generatedFrom.resourceId, annotationId: event.generatedFrom.annotationId }
        : undefined;

      await this.kb.eventStore.appendEvent({
        type: 'yield:created',
        resourceId: rId,
        userId: makeUserId(event.userId),
        version: 1,
        payload: {
          name: event.name,
          format: event.format,
          contentChecksum: checksum,
          contentByteSize: byteSize,
          storageUri: event.storageUri,
          creationMethod: validatedCreationMethod,
          entityTypes: event.entityTypes || [],
          language: event.language || undefined,
          isDraft: event.isDraft ?? false,
          generatedFrom,
          generationPrompt: event.generationPrompt,
          generator: event.generator,
        },
      });

      const resource: ResourceDescriptor = {
        '@context': 'https://schema.org/' as const,
        '@id': rId,
        name: event.name,
        archived: false,
        entityTypes: event.entityTypes || [],
        creationMethod: validatedCreationMethod,
        storageUri: event.storageUri,
        currentChecksum: checksum,
        dateCreated: new Date().toISOString(),
        representations: [
          {
            mediaType: event.format,
            checksum,
            byteSize,
            rel: 'original' as const,
            language: event.language,
          },
        ],
      };

      this.eventBus.get('yield:create-ok').next({ resourceId: rId, resource });
    } catch (error) {
      this.logger.error('Failed to create resource', { error });
      this.eventBus.get('yield:create-failed').next({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleYieldUpdate(event: EventMap['yield:update']): Promise<void> {
    try {
      // Content is already on disk at storageUri (callers write before emitting).
      // register() verifies the file exists and validates the checksum.
      await this.kb.content.register(event.storageUri, event.contentChecksum, { noGit: event.noGit });
      await this.kb.eventStore.appendEvent({
        type: 'yield:updated',
        resourceId: resourceId(event.resourceId),
        userId: makeUserId(event.userId),
        version: 1,
        payload: {
          contentChecksum: event.contentChecksum,
          contentByteSize: event.byteSize,
        },
      });
      this.eventBus.get('yield:update-ok').next({ resourceId: event.resourceId });
    } catch (error) {
      this.logger.error('Failed to update resource', { error });
      this.eventBus.get('yield:update-failed').next({
        resourceId: event.resourceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleYieldMv(event: EventMap['yield:mv']): Promise<void> {
    let rId: ResourceId;
    try {
      const resolved = await resolveStorageUri(this.kb.projectionsDir, event.fromUri);
      rId = resolved as ResourceId;
    } catch (error) {
      this.logger.error('Failed to resolve resource for move', { fromUri: event.fromUri, error });
      this.eventBus.get('yield:move-failed').next({
        fromUri: event.fromUri,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      await this.kb.content.move(event.fromUri, event.toUri, { noGit: event.noGit });
      await this.kb.eventStore.appendEvent({
        type: 'yield:moved',
        resourceId: rId,
        userId: makeUserId(event.userId),
        version: 1,
        payload: {
          fromUri: event.fromUri,
          toUri: event.toUri,
        },
      });
      this.eventBus.get('yield:move-ok').next({ resourceId: rId });
    } catch (error) {
      this.logger.error('Failed to move resource', { error });
      this.eventBus.get('yield:move-failed').next({
        fromUri: event.fromUri,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleMarkCreate(event: EventMap['mark:create']): Promise<void> {
    try {
      this.logger.debug('Stowing annotation', { annotationId: event.annotation.id });
      await this.kb.eventStore.appendEvent(
        {
          type: 'mark:added',
          resourceId: resourceId(event.resourceId),
          userId: makeUserId(event.userId),
          version: 1,
          payload: { annotation: event.annotation },
        },
        event.correlationId ? { correlationId: event.correlationId } : undefined,
      );
      // annotation-assembly emits mark:create-ok after it observes the
      // persisted mark:added event (keyed by correlationId in metadata).
    } catch (error) {
      this.logger.error('Failed to create annotation', { error });
      this.eventBus.get('mark:create-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleMarkDelete(event: EventMap['mark:delete']): Promise<void> {
    if (!event.userId || !event.resourceId) {
      return; // Frontend-only event — handled by route, not Stower
    }

    try {
      await this.kb.eventStore.appendEvent({
        type: 'mark:removed',
        resourceId: resourceId(event.resourceId),
        userId: makeUserId(event.userId),
        version: 1,
        payload: { annotationId: event.annotationId },
      });
      this.eventBus.get('mark:delete-ok').next({ annotationId: event.annotationId });
    } catch (error) {
      this.logger.error('Failed to delete annotation', { error });
      this.eventBus.get('mark:delete-failed').next({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleMarkUpdateBody(event: EventMap['mark:update-body']): Promise<void> {
    try {
      await this.kb.eventStore.appendEvent(
        {
          type: 'mark:body-updated',
          resourceId: resourceId(event.resourceId),
          userId: makeUserId(event.userId),
          version: 1,
          payload: { annotationId: event.annotationId, operations: event.operations },
        },
        // Thread correlationId from the command into event metadata so the
        // events-stream can deliver it to the client that initiated the bind.
        event.correlationId ? { correlationId: event.correlationId } : undefined,
      );
      // No manual .next() needed — appendEvent publishes StoredEvent on the Core EventBus
    } catch (error) {
      this.logger.error('Failed to update annotation body', { error });
      this.eventBus.get('mark:body-update-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleMarkArchive(event: EventMap['mark:archive']): Promise<void> {
    if (!event.userId) {
      this.logger.warn('mark:archive missing userId — skipping (frontend-only event?)');
      return;
    }
    if (event.storageUri) {
      await this.kb.content.remove(event.storageUri, { keepFile: event.keepFile, noGit: event.noGit });
    }
    await this.kb.eventStore.appendEvent({
      type: 'mark:archived',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event.userId),
      version: 1,
      payload: { reason: undefined },
    });
  }

  private async handleMarkUnarchive(event: EventMap['mark:unarchive']): Promise<void> {
    if (!event.userId) {
      this.logger.warn('mark:unarchive missing userId — skipping (frontend-only event?)');
      return;
    }
    // If storageUri is provided, verify the file exists before emitting the event
    if (event.storageUri) {
      const absPath = this.kb.content.resolveUri(event.storageUri);
      try {
        await fs.access(absPath);
      } catch {
        this.logger.warn('Unarchive failed: file not found at storageUri', { storageUri: event.storageUri });
        return;
      }
    }
    await this.kb.eventStore.appendEvent({
      type: 'mark:unarchived',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event.userId),
      version: 1,
      payload: {},
    });
  }

  private async handleAddEntityType(event: EventMap['mark:add-entity-type']): Promise<void> {
    try {
      await this.kb.eventStore.appendEvent({
        type: 'mark:entity-type-added',
        userId: makeUserId(event.userId),
        version: 1,
        payload: { entityType: event.tag },
      });
      // No manual .next() needed — appendEvent publishes StoredEvent on the Core EventBus
    } catch (error) {
      this.logger.error('Failed to add entity type', { error });
      this.eventBus.get('mark:entity-type-add-failed').next({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleUpdateEntityTypes(event: EventMap['mark:update-entity-types']): Promise<void> {
    const added = event.updatedEntityTypes.filter(et => !event.currentEntityTypes.includes(et));
    const removed = event.currentEntityTypes.filter(et => !event.updatedEntityTypes.includes(et));

    for (const entityType of added) {
      await this.kb.eventStore.appendEvent({
        type: 'mark:entity-tag-added',
        resourceId: resourceId(event.resourceId),
        userId: makeUserId(event.userId),
        version: 1,
        payload: { entityType },
      });
    }

    for (const entityType of removed) {
      await this.kb.eventStore.appendEvent({
        type: 'mark:entity-tag-removed',
        resourceId: resourceId(event.resourceId),
        userId: makeUserId(event.userId),
        version: 1,
        payload: { entityType },
      });
    }
  }

  private async handleJobStart(event: EventMap['job:start']): Promise<void> {
    await this.kb.eventStore.appendEvent({
      type: 'job:started',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event.userId),
      version: 1,
      payload: { jobId: event.jobId, jobType: event.jobType },
    });
  }

  private async handleJobReportProgress(event: EventMap['job:report-progress']): Promise<void> {
    await this.kb.eventStore.appendEvent({
      type: 'job:progress',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event.userId),
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
      type: 'job:completed',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event.userId),
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
      type: 'job:failed',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event.userId),
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
