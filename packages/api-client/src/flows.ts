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
import type { EventMap, EventBus, ResourceId, Selector, AccessToken } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
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
      this.eventBus.get('bind:update-body').subscribe(async (event: EventMap['bind:update-body']) => {
        try {
          // Plain POST — the backend emits mark:update-body on the EventBus,
          // the Stower persists mark:body-updated, and the events-stream
          // delivers the enriched event to all connected clients. The
          // AnnotationStore's mark:body-updated subscriber calls updateInPlace
          // with the post-materialization annotation — no per-operation
          // stream, no bind:finished channel needed.
          await this.http.bindAnnotation(
            rUri,
            makeAnnotationId(event.annotationId),
            { operations: event.operations as never },
            { auth: getToken() },
          );
        } catch (error) {
          this.eventBus.get('bind:body-update-failed').next({
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    sub.add(
      this.eventBus.get('match:search-requested').subscribe(async (event: EventMap['match:search-requested']) => {
        try {
          // Plain POST — the backend emits match:search-requested on the
          // EventBus, the Binder processes the search and publishes results
          // on the resource-scoped bus. The events-stream delivers them to
          // all connected clients. The wizard's existing match:search-results
          // subscription on the local EventBus picks them up via the SSE
          // auto-router.
          await this.http.matchSearch(rUri, {
            correlationId: event.correlationId,
            referenceId: event.referenceId,
            context: event.context,
            limit: event.limit,
            useSemanticScoring: event.useSemanticScoring,
          }, { auth: getToken() });
        } catch (error) {
          this.eventBus.get('match:search-failed').next({
            correlationId: event.correlationId,
            referenceId: event.referenceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return sub;
  }

  // ─── yield flow ────────────────────────────────────────────────────────────

  /**
   * Activate the yield (generation) flow for a resource.
   *
   * @subscribes yield:request — calls HTTP yieldResource (non-blocking POST)
   * @subscribes yield:finished — links generated resource back to the reference annotation via bind:update-body
   * @subscribes job:cancel-requested (generation) — no-op after migration (job runs server-side)
   */
  yield(_rUri: ResourceId, getToken: TokenGetter): Subscription {
    const sub = new Subscription();

    sub.add(
      this.eventBus.get('yield:request').subscribe(async (event: EventMap['yield:request']) => {
        const { context, ...rest } = event.options;
        if (!context) throw new Error('yield:request requires gathered context');
        try {
          // Plain POST — the backend creates the generation job and returns
          // immediately. Progress (yield:progress) and completion
          // (yield:finished) arrive via the events-stream from the worker.
          await this.http.yieldResourceFromAnnotation(
            makeResourceId(event.resourceId),
            makeAnnotationId(event.annotationId),
            { ...rest, context },
            { auth: getToken() },
          );
        } catch (error) {
          this.eventBus.get('yield:failed').next({
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
            referenceId: event.annotationId,
            percentage: 0,
            message: error instanceof Error ? error.message : 'Generation failed',
          });
        }
      }),
    );

    sub.add(
      this.eventBus.get('yield:finished').subscribe((event: EventMap['yield:finished']) => {
        // Link the newly generated resource back to the reference annotation
        if (!event.resourceId || !event.referenceId || !event.sourceResourceId) return;
        this.eventBus.get('bind:update-body').next({
          correlationId: crypto.randomUUID(),
          annotationId: makeAnnotationId(event.referenceId),
          resourceId: makeResourceId(event.sourceResourceId),
          operations: [{ op: 'add', item: { type: 'SpecificResource', source: event.resourceId } }],
        });
      }),
    );

    // Note: job:cancel-requested for generation is now a server-side concern.
    // The job runs independently of the client connection. Client-side abort
    // of a POST that already returned 202 is not meaningful. If cancellation
    // is needed, it should be a POST /jobs/{jobId}/cancel endpoint.

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

    sub.add(
      this.eventBus.get('mark:submit').subscribe(async (event: EventMap['mark:submit']) => {
        try {
          const result = await this.http.markAnnotation(rUri, {
            motivation: event.motivation,
            target: { source: rUri, selector: event.selector as Selector },
            body: event.body,
          }, { auth: getToken() });
          this.eventBus.get('mark:create-ok').next({ annotationId: makeAnnotationId(result.annotationId) });
        } catch (error) {
          this.eventBus.get('mark:create-failed').next({ message: error instanceof Error ? error.message : String(error) });
        }
      }),
    );

    sub.add(
      this.eventBus.get('mark:delete').subscribe(async (event: EventMap['mark:delete']) => {
        try {
          await this.http.deleteAnnotation(rUri, makeAnnotationId(event.annotationId), { auth: getToken() });
          this.eventBus.get('mark:delete-ok').next({ annotationId: event.annotationId });
        } catch (error) {
          this.eventBus.get('mark:delete-failed').next({ message: error instanceof Error ? error.message : String(error) });
        }
      }),
    );

    sub.add(
      this.eventBus.get('mark:assist-request').subscribe(async (event: EventMap['mark:assist-request']) => {
        const { motivation, options } = event;
        const auth = getToken();

        try {
          // Plain POSTs — the backend creates a job and returns immediately.
          // Progress (mark:progress) and completion (mark:assist-finished) or
          // failure (mark:assist-failed) arrive via the events-stream from
          // the workers.
          if (motivation === 'tagging') {
            const { schemaId, categories } = options;
            if (!schemaId || !categories?.length) throw new Error('Tag assist requires schemaId and categories');
            await this.http.annotateTags(rUri, { schemaId, categories }, { auth });
          } else if (motivation === 'linking') {
            const { entityTypes, includeDescriptiveReferences } = options;
            if (!entityTypes?.length) throw new Error('Reference assist requires entityTypes');
            await this.http.annotateReferences(rUri, {
              entityTypes: entityTypes as string[],
              includeDescriptiveReferences: includeDescriptiveReferences ?? false,
            }, { auth });
          } else if (motivation === 'highlighting') {
            await this.http.annotateHighlights(rUri, { instructions: options.instructions, density: options.density }, { auth });
          } else if (motivation === 'assessing') {
            await this.http.annotateAssessments(rUri, {
              instructions: options.instructions,
              tone: options.tone,
              density: options.density,
              language: options.language,
            }, { auth });
          } else if (motivation === 'commenting') {
            await this.http.annotateComments(rUri, {
              instructions: options.instructions,
              tone: options.tone,
              density: options.density,
              language: options.language,
            }, { auth });
          }
        } catch (error) {
          this.eventBus.get('mark:assist-failed').next({
            resourceId: rUri as string,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return sub;
  }

  // ─── gatherContext flow ─────────────────────────────────────────────────────

  /**
   * Activate the gather-context flow for a resource.
   *
   * @subscribes gather:requested — calls HTTP gatherAnnotationContext
   * @emits gather:failed on HTTP error
   */
  gatherContext(rUri: ResourceId, getToken: TokenGetter): Subscription {
    return this.eventBus.get('gather:requested').subscribe(async (event: EventMap['gather:requested']) => {
      try {
        // Plain POST — the backend emits gather:requested on the EventBus,
        // the Gatherer processes the context assembly and publishes
        // gather:complete / gather:failed on the resource-scoped bus. The
        // events-stream delivers them to all connected clients. The
        // useContextGatherFlow hook's existing gather:complete subscription
        // picks them up via the SSE auto-router.
        await this.http.gatherAnnotationContext(
          rUri,
          makeAnnotationId(event.annotationId),
          {
            correlationId: event.correlationId,
            contextWindow: event.options?.contextWindow ?? 2000,
          },
          { auth: getToken() },
        );
      } catch (error) {
        this.eventBus.get('gather:failed').next({
          correlationId: event.correlationId,
          annotationId: event.annotationId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
