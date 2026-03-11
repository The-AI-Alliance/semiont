/**
 * Binder Actor
 *
 * Bridge between the event bus and the knowledge base for entity resolution.
 * Subscribes to bind search events, queries KB stores (graph, views),
 * and emits search results back to the bus.
 *
 * From ARCHITECTURE-NEXT.md:
 * "When an Analyst or Linker Agent emits a bind event, the Binder receives it
 * from the bus, searches the KB stores for matching resources, and resolves
 * references — linking a mention to its referent."
 *
 * The Binder handles only the read side (searching for candidates).
 * The write side (annotation.body.updated) stays in the route where
 * userId is available from auth context. That domain event still flows
 * through the bus via EventStore auto-publish.
 */

import { Subscription, from } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import type { EventMap, Logger } from '@semiont/core';
import type { EventBus } from '@semiont/core';
import type { KnowledgeBase } from './knowledge-base';

export class Binder {
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
    this.logger.info('Binder actor initialized');

    this.subscription = this.eventBus.get('bind:search-requested').pipe(
      concatMap((event) => from(this.handleSearch(event))),
    ).subscribe({
      error: (err) => this.logger.error('Binder pipeline error', { error: err }),
    });
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

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.logger.info('Binder actor stopped');
  }
}
