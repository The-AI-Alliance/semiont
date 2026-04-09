/**
 * Clone Token Manager
 *
 * Reactive actor that handles clone token operations via the EventBus.
 * Manages an in-memory token store for resource cloning workflows.
 *
 * Handles:
 * - yield:clone-token-requested — generate a clone token for a resource
 * - yield:clone-resource-requested — look up a resource by clone token
 * - yield:clone-create — create a new resource from a clone token
 *
 * From COMPLETE-EVENT-PROTOCOL.md:
 * "Clone tokens produce new resources — that's yield."
 */

import { Subscription, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type { EventMap, Logger, ResourceId } from '@semiont/core';
import { type EventBus, CREATION_METHODS, cloneToken as makeCloneToken, type CloneToken } from '@semiont/core';
import { getPrimaryRepresentation, getResourceEntityTypes } from '@semiont/api-client';
import { deriveStorageUri } from '@semiont/content';
import { ResourceContext } from './resource-context';
import { ResourceOperations } from './resource-operations';
import type { KnowledgeBase } from './knowledge-base';

export class CloneTokenManager {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;
  private readonly tokens = new Map<CloneToken, { resourceId: ResourceId; expiresAt: Date }>();

  constructor(
    private kb: KnowledgeBase,
    private eventBus: EventBus,
    logger: Logger,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('CloneTokenManager actor initialized');

    const errorHandler = (err: unknown) => this.logger.error('CloneTokenManager pipeline error', { error: err });

    const generateToken$ = this.eventBus.get('yield:clone-token-requested').pipe(
      mergeMap((event) => from(this.handleGenerateToken(event))),
    );

    const getResource$ = this.eventBus.get('yield:clone-resource-requested').pipe(
      mergeMap((event) => from(this.handleGetResource(event))),
    );

    const createResource$ = this.eventBus.get('yield:clone-create').pipe(
      mergeMap((event) => from(this.handleCreateResource(event))),
    );

    this.subscriptions.push(
      generateToken$.subscribe({ error: errorHandler }),
      getResource$.subscribe({ error: errorHandler }),
      createResource$.subscribe({ error: errorHandler }),
    );
  }

  private async handleGenerateToken(event: EventMap['yield:clone-token-requested']): Promise<void> {
    try {
      const resource = await ResourceContext.getResourceMetadata(event.resourceId, this.kb);
      if (!resource) {
        this.eventBus.get('yield:clone-token-failed').next({
          correlationId: event.correlationId,
          message: 'Resource not found',
        });
        return;
      }

      // Verify content exists
      if (!resource.storageUri) {
        this.eventBus.get('yield:clone-token-failed').next({
          correlationId: event.correlationId,
          message: 'Resource content not found',
        });
        return;
      }

      try {
        await this.kb.content.retrieve(resource.storageUri);
      } catch {
        this.eventBus.get('yield:clone-token-failed').next({
          correlationId: event.correlationId,
          message: 'Resource content not found',
        });
        return;
      }

      // Generate token
      const tokenStr = `clone_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;
      const token = makeCloneToken(tokenStr);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      this.tokens.set(token, { resourceId: event.resourceId, expiresAt });

      this.eventBus.get('yield:clone-token-generated').next({
        correlationId: event.correlationId,
        response: {
          token,
          expiresAt: expiresAt.toISOString(),
          resource,
        },
      });
    } catch (error) {
      this.logger.error('Generate clone token failed', { resourceId: event.resourceId, error });
      this.eventBus.get('yield:clone-token-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleGetResource(event: EventMap['yield:clone-resource-requested']): Promise<void> {
    try {
      const token = makeCloneToken(event.token);
      const tokenData = this.tokens.get(token);

      if (!tokenData) {
        this.eventBus.get('yield:clone-resource-failed').next({
          correlationId: event.correlationId,
          message: 'Invalid or expired token',
        });
        return;
      }

      if (new Date() > tokenData.expiresAt) {
        this.tokens.delete(token);
        this.eventBus.get('yield:clone-resource-failed').next({
          correlationId: event.correlationId,
          message: 'Token expired',
        });
        return;
      }

      const sourceResource = await ResourceContext.getResourceMetadata(tokenData.resourceId, this.kb);
      if (!sourceResource) {
        this.eventBus.get('yield:clone-resource-failed').next({
          correlationId: event.correlationId,
          message: 'Source resource not found',
        });
        return;
      }

      this.eventBus.get('yield:clone-resource-result').next({
        correlationId: event.correlationId,
        response: {
          sourceResource,
          expiresAt: tokenData.expiresAt.toISOString(),
        },
      });
    } catch (error) {
      this.logger.error('Get clone resource failed', { token: event.token, error });
      this.eventBus.get('yield:clone-resource-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCreateResource(event: EventMap['yield:clone-create']): Promise<void> {
    try {
      const token = makeCloneToken(event.token);
      const tokenData = this.tokens.get(token);

      if (!tokenData) {
        this.eventBus.get('yield:clone-create-failed').next({
          correlationId: event.correlationId,
          message: 'Invalid or expired token',
        });
        return;
      }

      if (new Date() > tokenData.expiresAt) {
        this.tokens.delete(token);
        this.eventBus.get('yield:clone-create-failed').next({
          correlationId: event.correlationId,
          message: 'Token expired',
        });
        return;
      }

      const sourceDoc = await ResourceContext.getResourceMetadata(tokenData.resourceId, this.kb);
      if (!sourceDoc) {
        this.eventBus.get('yield:clone-create-failed').next({
          correlationId: event.correlationId,
          message: 'Source resource not found',
        });
        return;
      }

      // Determine format
      const primaryRep = getPrimaryRepresentation(sourceDoc);
      const mediaType = primaryRep?.mediaType || 'text/plain';
      const validFormats = ['text/plain', 'text/markdown'] as const;
      const format: 'text/plain' | 'text/markdown' = validFormats.includes(mediaType as any)
        ? (mediaType as 'text/plain' | 'text/markdown')
        : 'text/plain';

      // Write content to disk, then create via EventBus (no Buffer on bus)
      const resolvedUri = deriveStorageUri(event.name, format);
      const stored = await this.kb.content.store(Buffer.from(event.content), resolvedUri);

      const resourceId = await ResourceOperations.createResource(
        {
          name: event.name,
          storageUri: resolvedUri,
          contentChecksum: stored.checksum,
          byteSize: stored.byteSize,
          format,
          entityTypes: getResourceEntityTypes(sourceDoc),
          creationMethod: CREATION_METHODS.CLONE,
        },
        event.userId,
        this.eventBus,
      );

      // Archive original if requested
      if (event.archiveOriginal) {
        ResourceOperations.updateResource(
          {
            resourceId: tokenData.resourceId,
            userId: event.userId,
            currentArchived: sourceDoc.archived,
            updatedArchived: true,
          },
          this.eventBus,
        );
      }

      // Clean up token
      this.tokens.delete(token);

      this.eventBus.get('yield:clone-created').next({
        correlationId: event.correlationId,
        response: { resourceId },
      });
    } catch (error) {
      this.logger.error('Clone create failed', { token: event.token, error });
      this.eventBus.get('yield:clone-create-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.tokens.clear();
    this.logger.info('CloneTokenManager actor stopped');
  }
}
