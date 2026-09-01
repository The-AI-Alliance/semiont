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

import { promises as fs } from 'fs';
import { Subscription, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type { EventMap, Logger, ResourceId } from '@semiont/core';
import { type EventBus, cloneToken as makeCloneToken, type CloneToken, resourceId, userId as makeUserId } from '@semiont/core';
import { getResourceEntityTypes, getStorageUri } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';
import type { WorkingTreeStore } from '@semiont/content';
import { ResourceContext } from './resource-context';
import { ResourceOperations } from './resource-operations';

/**
 * What the clone workflow touches (EXTRACT-ARCHIVIST P1/P3): resource
 * metadata via views, and `resolveUri` for existence checks — never bytes
 * (GATEWAY.md D4a). The clone's own bytes are stored by the gateway's
 * upload path before `yield:clone-create` arrives; this actor holds NO
 * byte capability at all.
 */
export interface CloneTokenStores {
  views: Pick<ViewStorage, 'get'>;
  content: Pick<WorkingTreeStore, 'resolveUri'>;
}

/**
 * The command channels CloneTokenManager subscribes to — the Archivist's
 * inbound wire roster for this actor (EXTRACT-ARCHIVIST P2a). Pinned to
 * `initialize()`'s actual subscriptions by the census gate in
 * archivist-decoupling.test.ts.
 */
export const CLONE_TOKEN_CHANNELS = [
  'yield:clone-token-requested', 'yield:clone-resource-requested', 'yield:clone-create',
] as const satisfies readonly (keyof EventMap)[];

export class CloneTokenManager {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;
  private readonly tokens = new Map<CloneToken, { resourceId: ResourceId; expiresAt: Date }>();

  constructor(
    private stores: CloneTokenStores,
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
      const resource = await ResourceContext.getResourceMetadata(resourceId(event.resourceId), this.stores);
      if (!resource) {
        this.eventBus.get('yield:clone-token-failed').next({
          correlationId: event.correlationId,
          message: 'Resource not found',
        });
        return;
      }

      // Verify content exists
      const storageUri = getStorageUri(resource);
      if (!storageUri) {
        this.eventBus.get('yield:clone-token-failed').next({
          correlationId: event.correlationId,
          message: 'Resource content not found',
        });
        return;
      }

      // Existence check only: resolve + stat, never a byte read (D4a).
      try {
        await fs.access(this.stores.content.resolveUri(storageUri));
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

      this.tokens.set(token, { resourceId: resourceId(event.resourceId), expiresAt });

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

      const sourceResource = await ResourceContext.getResourceMetadata(tokenData.resourceId, this.stores);
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
      if (!event._userId) {
        this.eventBus.get('yield:clone-create-failed').next({
          correlationId: event.correlationId,
          message: 'yield:clone-create missing _userId (gateway injection)',
        });
        return;
      }

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

      const sourceDoc = await ResourceContext.getResourceMetadata(tokenData.resourceId, this.stores);
      if (!sourceDoc) {
        this.eventBus.get('yield:clone-create-failed').next({
          correlationId: event.correlationId,
          message: 'Source resource not found',
        });
        return;
      }

      // Bytes are already on disk — the gateway's upload path stored them
      // (noGit) before emitting this command, and the SDK applied the
      // clone-format gate (core `cloneFormat`) when deriving the upload.
      // This actor contributes what only it knows: token validity and the
      // source's entity types.
      const newResourceId = await ResourceOperations.createResource(
        {
          name: event.name,
          storageUri: event.storageUri,
          contentChecksum: event.contentChecksum,
          byteSize: event.byteSize,
          format: event.format,
          entityTypes: getResourceEntityTypes(sourceDoc),
        },
        makeUserId(event._userId),
        this.eventBus,
      );

      // Archive original if requested
      if (event.archiveOriginal && !sourceDoc.archived) {
        this.eventBus.get('mark:archive').next({
          _userId: event._userId,
          resourceId: tokenData.resourceId,
        });
      }

      // Clean up token
      this.tokens.delete(token);

      this.eventBus.get('yield:clone-created').next({
        correlationId: event.correlationId,
        response: { resourceId: newResourceId },
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
