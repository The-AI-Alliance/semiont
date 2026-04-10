/**
 * MatchNamespace — search and ranking
 *
 * Long-running (semantic search, optional LLM scoring). Returns
 * Observable with results.
 *
 * Backend actor: Matcher
 * Event prefix: match:*
 */

import { Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { ResourceId, AccessToken, GatheredContext, EventBus } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { MatchNamespace as IMatchNamespace, MatchSearchProgress } from './types';

type TokenGetter = () => AccessToken | undefined;

export class MatchNamespace implements IMatchNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly eventBus: EventBus,
    private readonly getToken: TokenGetter,
  ) {}

  search(
    resourceId: ResourceId,
    referenceId: string,
    context: GatheredContext,
    options?: { limit?: number; useSemanticScoring?: boolean },
  ): Observable<MatchSearchProgress> {
    return new Observable((subscriber) => {
      const correlationId = crypto.randomUUID();

      const result$ = this.eventBus.get('match:search-results').pipe(
        filter((e) => e.correlationId === correlationId),
      );
      const failed$ = this.eventBus.get('match:search-failed').pipe(
        filter((e) => e.correlationId === correlationId),
      );

      const resultSub = result$.subscribe((e) => {
        subscriber.next(e as MatchSearchProgress);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.error));
      });

      // Fire the HTTP POST
      this.http.matchSearch(
        resourceId,
        {
          correlationId,
          referenceId,
          context,
          limit: options?.limit,
          useSemanticScoring: options?.useSemanticScoring,
        },
        { auth: this.getToken() },
      ).catch((error) => {
        subscriber.error(error);
      });

      return () => {
        resultSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }
}
