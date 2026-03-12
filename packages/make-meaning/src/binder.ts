/**
 * Binder Actor
 *
 * Bridge between the event bus and the knowledge base for entity resolution.
 * Subscribes to bind search events and referenced-by queries, queries KB stores
 * (graph, views), and emits results back to the bus.
 *
 * From ARCHITECTURE-NEXT.md:
 * "When an Analyst or Linker Agent emits a bind event, the Binder receives it
 * from the bus, searches the KB stores for matching resources, and resolves
 * references — linking a mention to its referent."
 *
 * Handles:
 * - bind:search-requested — search for binding candidates
 * - bind:referenced-by-requested — find annotations that reference a resource
 *
 * The Binder handles only the read side (searching for candidates).
 * The write side (annotation.body.updated) stays in the route where
 * userId is available from auth context. That domain event still flows
 * through the bus via EventStore auto-publish.
 */

import { Subscription, from } from 'rxjs';
import { concatMap, mergeMap } from 'rxjs/operators';
import type { EventMap, Logger } from '@semiont/core';
import { type EventBus, resourceIdToURI, resourceUri as makeResourceUri } from '@semiont/core';
import { getExactText, getTargetSource, getTargetSelector } from '@semiont/api-client';
import type { KnowledgeBase } from './knowledge-base';

export class Binder {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private kb: KnowledgeBase,
    private eventBus: EventBus,
    logger: Logger,
    private publicURL?: string,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Binder actor initialized');

    const errorHandler = (err: unknown) => this.logger.error('Binder pipeline error', { error: err });

    const search$ = this.eventBus.get('bind:search-requested').pipe(
      concatMap((event) => from(this.handleSearch(event))),
    );

    const referencedBy$ = this.eventBus.get('bind:referenced-by-requested').pipe(
      mergeMap((event) => from(this.handleReferencedBy(event))),
    );

    this.subscriptions.push(
      search$.subscribe({ error: errorHandler }),
      referencedBy$.subscribe({ error: errorHandler }),
    );
  }

  private async handleSearch(event: EventMap['bind:search-requested']): Promise<void> {
    try {
      this.logger.debug('Searching for binding candidates', {
        referenceId: event.referenceId,
        searchTerm: event.searchTerm,
      });

      const results = await this.kb.graph.searchResources(event.searchTerm);

      this.eventBus.get('bind:search-results').next({
        referenceId: event.referenceId,
        searchTerm: event.searchTerm,
        results,
      });
    } catch (error) {
      this.logger.error('Bind search failed', {
        referenceId: event.referenceId,
        error,
      });
      this.eventBus.get('bind:search-failed').next({
        referenceId: event.referenceId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleReferencedBy(event: EventMap['bind:referenced-by-requested']): Promise<void> {
    try {
      if (!this.publicURL) {
        throw new Error('publicURL required for referenced-by queries');
      }

      const resourceUri = resourceIdToURI(event.resourceId, this.publicURL);
      this.logger.debug('Looking for annotations referencing resource', {
        resourceId: event.resourceId,
        resourceUri,
        motivation: event.motivation || 'all',
      });

      const references = await this.kb.graph.getResourceReferencedBy(resourceUri, event.motivation);

      // Get unique source resources
      const docIds = [...new Set(references.map(ref => getTargetSource(ref.target)))];
      const resources = await Promise.all(docIds.map(docId => this.kb.graph.getResource(makeResourceUri(docId))));

      // Build resource map for lookup
      const docMap = new Map(resources.filter(doc => doc !== null).map(doc => [doc['@id'], doc]));

      // Transform into ReferencedBy structure
      const referencedBy = references.map(ref => {
        const targetSource = getTargetSource(ref.target);
        const targetSelector = getTargetSelector(ref.target);
        const doc = docMap.get(targetSource);
        return {
          id: ref.id,
          resourceName: doc?.name || 'Untitled Resource',
          target: {
            source: targetSource,
            selector: {
              exact: targetSelector ? getExactText(targetSelector) : '',
            },
          },
        };
      });

      this.eventBus.get('bind:referenced-by-result').next({
        correlationId: event.correlationId,
        response: { referencedBy },
      });
    } catch (error) {
      this.logger.error('Referenced-by query failed', {
        resourceId: event.resourceId,
        error,
      });
      this.eventBus.get('bind:referenced-by-failed').next({
        correlationId: event.correlationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.logger.info('Binder actor stopped');
  }
}
