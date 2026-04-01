/**
 * FlowEngine — framework-agnostic flow orchestration
 *
 * Owns the subscription/SSE-bridge logic that was previously scattered across
 * React hooks (useBindFlow, useYieldFlow, useMarkFlow, useContextGatherFlow,
 * useResourceEvents, useAttentionStream).
 *
 * Each method accepts a `getToken` function called at event-handling time so
 * the token is always fresh (the client is stateless; tokens rotate).
 *
 * Each method returns an RxJS Subscription. The caller is responsible for
 * calling .unsubscribe() when the flow is no longer needed (e.g. in a
 * React useEffect cleanup or on workspace teardown).
 *
 * No React imports. No DOM imports. Pure RxJS + EventBus.
 */

import { Subscription } from 'rxjs';
import type { EventMap, EventBus, ResourceId, Selector, EntityType, AccessToken } from '@semiont/core';
import { annotationId as makeAnnotationId } from '@semiont/core';
import type { SSEClient } from './sse/index';
import type { SemiontApiClient } from './client';

export type TokenGetter = () => AccessToken | undefined;

export class FlowEngine {
  constructor(
    private readonly eventBus: EventBus,
    private readonly sse: SSEClient,
    private readonly http: SemiontApiClient,
  ) {}

  // ─── bind flow ─────────────────────────────────────────────────────────────

  /**
   * Activate the bind flow for a resource.
   *
   * @subscribes bind:update-body  — calls SSE bindAnnotation
   * @subscribes match:search-requested — calls SSE bindSearch
   * @emits bind:body-updated, bind:body-update-failed
   */
  bind(rUri: ResourceId, getToken: TokenGetter): Subscription {
    const sub = new Subscription();

    sub.add(
      this.eventBus.get('bind:update-body').subscribe((event: EventMap['bind:update-body']) => {
        const annotationId = event.annotationId;

        const finishedSub = this.eventBus.get('bind:finished').subscribe((finishedEvent) => {
          if (finishedEvent.annotationId !== annotationId) return;
          finishedSub.unsubscribe();
          failedSub.unsubscribe();
          this.eventBus.get('bind:body-updated').next({ annotationId });
        });

        const failedSub = this.eventBus.get('bind:failed').subscribe(() => {
          finishedSub.unsubscribe();
          failedSub.unsubscribe();
          this.eventBus.get('bind:body-update-failed').next({ error: new Error('Bind failed') });
        });

        this.sse.bindAnnotation(
          rUri,
          annotationId,
          { resourceId: event.resourceId, operations: event.operations as never },
          { auth: getToken(), eventBus: this.eventBus },
        );
      }),
    );

    sub.add(
      this.eventBus.get('match:search-requested').subscribe((event: EventMap['match:search-requested']) => {
        this.sse.matchSearch(rUri, {
          correlationId: event.correlationId,
          referenceId: event.referenceId,
          context: event.context,
          limit: event.limit,
          useSemanticScoring: event.useSemanticScoring,
        }, { auth: getToken(), eventBus: this.eventBus });
      }),
    );

    return sub;
  }

  // ─── yield flow ────────────────────────────────────────────────────────────

  /**
   * Activate the yield (generation) flow for a resource.
   *
   * @subscribes yield:request — calls SSE yieldResource
   * @subscribes job:cancel-requested (generation) — aborts in-flight stream
   */
  yield(_rUri: ResourceId, getToken: TokenGetter): Subscription {
    const sub = new Subscription();
    let abortController: AbortController | null = null;

    sub.add(
      this.eventBus.get('yield:request').subscribe((event: EventMap['yield:request']) => {
        abortController?.abort();
        abortController = new AbortController();
        this.sse.yieldResource(
          event.resourceId,
          event.annotationId,
          event.options,
          { auth: getToken(), eventBus: this.eventBus },
        );
      }),
    );

    sub.add(
      this.eventBus.get('job:cancel-requested').subscribe((event) => {
        if (event.jobType === 'generation') {
          abortController?.abort();
          abortController = null;
        }
      }),
    );

    sub.add(new Subscription(() => { abortController?.abort(); }));

    return sub;
  }

  // ─── mark flow ─────────────────────────────────────────────────────────────

  /**
   * Activate the mark (annotation CRUD + assist) flow for a resource.
   *
   * @subscribes mark:submit — HTTP markAnnotation
   * @subscribes mark:delete — HTTP deleteAnnotation
   * @subscribes mark:assist-request — SSE mark* (by motivation)
   * @subscribes job:cancel-requested (annotation) — aborts in-flight assist
   * @emits mark:created, mark:create-failed, mark:deleted, mark:delete-failed
   */
  mark(rUri: ResourceId, getToken: TokenGetter): Subscription {
    const sub = new Subscription();
    let assistAbort: AbortController | null = null;

    sub.add(
      this.eventBus.get('mark:submit').subscribe(async (event: EventMap['mark:submit']) => {
        try {
          const result = await this.http.markAnnotation(rUri, {
            motivation: event.motivation,
            target: { source: rUri, selector: event.selector as Selector },
            body: event.body,
          }, { auth: getToken() });
          this.eventBus.get('mark:created').next({ annotationId: makeAnnotationId(result.annotationId) });
        } catch (error) {
          this.eventBus.get('mark:create-failed').next({ error: error as Error });
        }
      }),
    );

    sub.add(
      this.eventBus.get('mark:delete').subscribe(async (event: EventMap['mark:delete']) => {
        try {
          await this.http.deleteAnnotation(rUri, event.annotationId, { auth: getToken() });
          this.eventBus.get('mark:deleted').next({ annotationId: event.annotationId });
        } catch (error) {
          this.eventBus.get('mark:delete-failed').next({ error: error as Error });
        }
      }),
    );

    sub.add(
      this.eventBus.get('mark:assist-request').subscribe(async (event: EventMap['mark:assist-request']) => {
        assistAbort?.abort();
        assistAbort = new AbortController();
        const opts = { auth: getToken(), eventBus: this.eventBus };
        const { motivation, options } = event;

        try {
          if (motivation === 'tagging') {
            const { schemaId, categories } = options;
            if (!schemaId || !categories?.length) throw new Error('Tag assist requires schemaId and categories');
            this.sse.markTags(rUri, { schemaId, categories }, opts);
          } else if (motivation === 'linking') {
            const { entityTypes, includeDescriptiveReferences } = options;
            if (!entityTypes?.length) throw new Error('Reference assist requires entityTypes');
            this.sse.markReferences(rUri, {
              entityTypes: entityTypes as EntityType[],
              includeDescriptiveReferences: includeDescriptiveReferences ?? false,
            }, opts);
          } else if (motivation === 'highlighting') {
            this.sse.markHighlights(rUri, { instructions: options.instructions, density: options.density }, opts);
          } else if (motivation === 'assessing') {
            this.sse.markAssessments(rUri, {
              instructions: options.instructions,
              tone: options.tone as 'analytical' | 'critical' | 'balanced' | 'constructive' | undefined,
              density: options.density,
              language: options.language,
            }, opts);
          } else if (motivation === 'commenting') {
            this.sse.markComments(rUri, {
              instructions: options.instructions,
              tone: options.tone as 'scholarly' | 'explanatory' | 'conversational' | 'technical' | undefined,
              density: options.density,
              language: options.language,
            }, opts);
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            this.eventBus.get('mark:assist-cancelled').next(undefined);
          }
        }
      }),
    );

    sub.add(
      this.eventBus.get('job:cancel-requested').subscribe((event) => {
        if (event.jobType === 'annotation') {
          assistAbort?.abort();
          assistAbort = null;
        }
      }),
    );

    sub.add(new Subscription(() => { assistAbort?.abort(); }));

    return sub;
  }

  // ─── gatherContext flow ─────────────────────────────────────────────────────

  /**
   * Activate the gather-context flow for a resource.
   *
   * @subscribes gather:requested — calls SSE gatherAnnotation, threads correlationId
   * @emits gather:complete (re-emitted from SSE gather:annotation-finished)
   */
  gatherContext(rUri: ResourceId, getToken: TokenGetter): Subscription {
    return this.eventBus.get('gather:requested').subscribe((event: EventMap['gather:requested']) => {
      const { correlationId } = event;
      const contextWindow = event.options?.contextWindow ?? 2000;

      const finishedSub = this.eventBus.get('gather:annotation-finished').subscribe((finishedEvent) => {
        if (finishedEvent.correlationId !== correlationId) return;
        finishedSub.unsubscribe();
        failedSub.unsubscribe();
        this.eventBus.get('gather:complete').next({
          correlationId,
          annotationId: finishedEvent.annotationId,
          response: finishedEvent.response,
        });
      });

      // failedSub: cleanup only — SSE layer already emitted gather:failed
      const failedSub = this.eventBus.get('gather:failed').subscribe((failedEvent) => {
        if (failedEvent.correlationId !== correlationId) return;
        finishedSub.unsubscribe();
        failedSub.unsubscribe();
      });

      this.sse.gatherAnnotation(
        rUri,
        event.annotationId,
        { contextWindow, correlationId },
        { auth: getToken(), eventBus: this.eventBus },
      );
    });
  }

  // ─── resourceEvents flow ───────────────────────────────────────────────────

  /**
   * Open the long-lived resource-events SSE stream.
   * Returns a Subscription whose teardown closes the stream.
   */
  resourceEvents(rUri: ResourceId, getToken: TokenGetter): Subscription {
    const stream = this.sse.resourceEvents(rUri, {
      auth: getToken(),
      eventBus: this.eventBus,
    });
    return new Subscription(() => stream.close());
  }

  // ─── attentionStream flow ──────────────────────────────────────────────────

  /**
   * Open the long-lived participant attention SSE stream.
   * Returns a Subscription whose teardown closes the stream.
   */
  attentionStream(getToken: TokenGetter): Subscription {
    const stream = this.sse.attentionStream({
      auth: getToken(),
      eventBus: this.eventBus,
    });
    return new Subscription(() => stream.close());
  }
}
