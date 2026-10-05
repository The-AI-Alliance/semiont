/**
 * The Librarian's retrieval handlers.
 *
 * Browse answers from the record: the event log, the views, the working
 * tree. These two answer from what is derived from it for finding things —
 * the graph, the vectors, an embedding — so they register wherever those
 * are held: beside the Matcher and the Gatherer, in the Librarian and in
 * the in-process root.
 *
 * - `match:resources-requested` — searching resources by text.
 * - `gather:referenced-by-requested` — what refers to a resource.
 */

import { EMPTY, from, type Subscription } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { errField, type EventBus, type EventMap, type Logger } from '@semiont/core';
import type { SemiontState } from '@semiont/core/node';
import type { ContentReads } from '@semiont/content';
import { withActorSpan } from '@semiont/observability';

import { findReferencedBy, type ReferencedByReads } from '../referenced-by.js';
import type { RETRIEVAL_HANDLER_CHANNELS } from '../service-channels.js';
import {
  searchResources,
  withContentPreviews,
  type ResourceSearchReads,
  type SemanticFallbackDeps,
} from '../resource-search.js';
import { personNamer } from '../views/people-reader.js';

/** What the two handlers read: each one's own slice, and the bytes a preview is cut from. */
export type RetrievalReads = ResourceSearchReads & ReferencedByReads & { content: ContentReads };

export interface RetrievalDeps extends Omit<SemanticFallbackDeps, 'logger'> {
  /** Where the people projection is: a reply names the people it mentions. */
  state: Pick<SemiontState, 'stateDir'>;
}

/** Register both handlers on `eventBus`. Returns what detaches them. */
export function registerRetrievalHandlers(
  eventBus: EventBus,
  kb: RetrievalReads,
  deps: RetrievalDeps,
  parentLogger: Logger,
): () => void {
  const logger = parentLogger.child({ component: 'resource-retrieval' });

  // Reads: each request is answered on its own, so they run concurrently.
  // A responder echoes the key it was handed; the payload carries none.
  const answer = <K extends (typeof RETRIEVAL_HANDLER_CHANNELS)[number]>(
    channel: K,
    actor: 'matcher' | 'gatherer',
    handler: (event: EventMap[K], correlationId: string | undefined) => Promise<void>,
  ): Subscription =>
    eventBus.frames(channel).pipe(
      mergeMap((frame) =>
        from(withActorSpan(actor, channel, () => handler(frame.payload, frame.correlationId))).pipe(
          // Each handler emits its own failure reply. This is the backstop
          // for a throw that escapes one: the subscription survives it.
          catchError((error) => {
            logger.error(`retrieval handler threw on ${channel}`, { error: errField(error) });
            return EMPTY;
          }),
        ),
      ),
    ).subscribe();

  const named = async <T>(reply: T): Promise<T> => (await personNamer(deps.state, logger))(reply);

  const subscriptions = [
    answer('match:resources-requested', 'matcher', async (event, correlationId) => {
      try {
        const offset = event.offset ?? 0;
        const limit = event.limit ?? 50;

        const result = await searchResources(
          { search: event.search, archived: event.archived, entityType: event.entityType, offset, limit },
          kb,
          { embeddingProvider: deps.embeddingProvider, semanticFloor: deps.semanticFloor, logger },
        );

        // Lexical hits get a preview. Semantic hits already carry `content` —
        // the passage that actually matched — and a first-200-characters
        // preview must not overwrite it.
        const resources = result.matchKind === 'lexical'
          ? await withContentPreviews(result.resources, kb.content)
          : result.resources;

        eventBus.emit('match:resources-result', {
          response: await named({
            resources,
            total: result.total,
            offset,
            limit,
            // The producer of the answer labels it.
            matchKind: result.matchKind,
          }),
        }, { correlationId });
      } catch (error) {
        logger.error('Resource search failed', { error: errField(error) });
        eventBus.emit('match:resources-failed', { message: error instanceof Error ? error.message : String(error) }, { correlationId });
      }
    }),

    answer('gather:referenced-by-requested', 'gatherer', async (event, correlationId) => {
      try {
        logger.debug('Looking for annotations referencing resource', {
          resourceId: event.resourceId,
          motivation: event.motivation || 'all',
        });
        const referencedBy = await findReferencedBy(kb, event.resourceId, event.motivation, logger);
        eventBus.emit('gather:referenced-by-result', { response: await named({ referencedBy }) }, { correlationId });
      } catch (error) {
        logger.error('Referenced-by query failed', { resourceId: event.resourceId, error: errField(error) });
        eventBus.emit('gather:referenced-by-failed', { message: error instanceof Error ? error.message : String(error) }, { correlationId });
      }
    }),
  ];

  return () => {
    for (const subscription of subscriptions) subscription.unsubscribe();
  };
}
