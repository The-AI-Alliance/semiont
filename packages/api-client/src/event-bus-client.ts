/**
 * EventBus-Only Client
 *
 * Implements the same knowledge-domain operations as SemiontApiClient
 * but communicates directly via EventBus instead of HTTP.
 *
 * This proves the EventBus is a complete interface for all knowledge-domain
 * operations. Binary content transfer and auth/admin stay HTTP-only.
 *
 * Usage:
 * ```typescript
 * import { EventBus } from '@semiont/core';
 * import { EventBusClient } from '@semiont/api-client';
 *
 * const eventBus = new EventBus();
 * const client = new EventBusClient(eventBus);
 *
 * const resources = await client.listResources({ limit: 10 });
 * const resource = await client.getResource(resourceId('doc-123'));
 * ```
 */

import { firstValueFrom, merge } from 'rxjs';
import { filter, map, take, timeout } from 'rxjs/operators';
import type { EventBus, EventMap, components } from '@semiont/core';
import type { ResourceId, AnnotationId, UserId } from '@semiont/core';
import type { JobId } from '@semiont/core';

type EventName = keyof EventMap;

/**
 * Send a request event and await a correlated response or failure.
 */
async function eventBusRequest<
  TReq extends EventName,
  TSuccess extends EventName,
  TFailure extends EventName,
>(
  eventBus: EventBus,
  requestEvent: TReq,
  payload: EventMap[TReq],
  successEvent: TSuccess,
  failureEvent: TFailure,
  timeoutMs = 30_000,
): Promise<(EventMap[TSuccess] & { response: any })['response']> {
  const correlationId = (payload as any).correlationId as string;

  const result$ = merge(
    eventBus.get(successEvent).pipe(
      filter((e: any) => e.correlationId === correlationId),
      map((e: any) => ({ ok: true as const, response: e.response })),
    ),
    eventBus.get(failureEvent).pipe(
      filter((e: any) => e.correlationId === correlationId),
      map((e: any) => ({ ok: false as const, error: e.error as Error })),
    ),
  ).pipe(take(1), timeout(timeoutMs));

  // firstValueFrom subscribes eagerly — must be called before .next()
  const resultPromise = firstValueFrom(result$);

  (eventBus.get(requestEvent) as any).next(payload);

  const result = await resultPromise;
  if (!result.ok) {
    throw result.error;
  }
  return result.response;
}

export class EventBusClient {
  constructor(
    private eventBus: EventBus,
    private timeoutMs = 30_000,
  ) {}

  // ========================================================================
  // Browse Flow — Resource reads
  // ========================================================================

  async getResource(
    resourceId: ResourceId,
  ): Promise<components['schemas']['GetResourceResponse']> {
    return eventBusRequest(
      this.eventBus,
      'browse:resource-requested',
      { correlationId: crypto.randomUUID(), resourceId },
      'browse:resource-result',
      'browse:resource-failed',
      this.timeoutMs,
    );
  }

  async listResources(options?: {
    search?: string;
    archived?: boolean;
    entityType?: string;
    offset?: number;
    limit?: number;
  }): Promise<components['schemas']['ListResourcesResponse']> {
    return eventBusRequest(
      this.eventBus,
      'browse:resources-requested',
      { correlationId: crypto.randomUUID(), ...options },
      'browse:resources-result',
      'browse:resources-failed',
      this.timeoutMs,
    );
  }

  // ========================================================================
  // Browse Flow — Annotation reads
  // ========================================================================

  async getAnnotations(
    resourceId: ResourceId,
  ): Promise<components['schemas']['GetAnnotationsResponse']> {
    return eventBusRequest(
      this.eventBus,
      'browse:annotations-requested',
      { correlationId: crypto.randomUUID(), resourceId },
      'browse:annotations-result',
      'browse:annotations-failed',
      this.timeoutMs,
    );
  }

  async getAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
  ): Promise<components['schemas']['GetAnnotationResponse']> {
    return eventBusRequest(
      this.eventBus,
      'browse:annotation-requested',
      { correlationId: crypto.randomUUID(), resourceId, annotationId },
      'browse:annotation-result',
      'browse:annotation-failed',
      this.timeoutMs,
    );
  }

  // ========================================================================
  // Browse Flow — Event history
  // ========================================================================

  async getEvents(
    resourceId: ResourceId,
    options?: {
      type?: string;
      userId?: string;
      limit?: number;
    },
  ): Promise<components['schemas']['GetEventsResponse']> {
    return eventBusRequest(
      this.eventBus,
      'browse:events-requested',
      { correlationId: crypto.randomUUID(), resourceId, ...options },
      'browse:events-result',
      'browse:events-failed',
      this.timeoutMs,
    );
  }

  async getAnnotationHistory(
    resourceId: ResourceId,
    annotationId: AnnotationId,
  ): Promise<components['schemas']['GetAnnotationHistoryResponse']> {
    return eventBusRequest(
      this.eventBus,
      'browse:annotation-history-requested',
      { correlationId: crypto.randomUUID(), resourceId, annotationId },
      'browse:annotation-history-result',
      'browse:annotation-history-failed',
      this.timeoutMs,
    );
  }

  // ========================================================================
  // Bind Flow — Graph queries
  // ========================================================================

  async getReferencedBy(
    resourceId: ResourceId,
    motivation?: string,
  ): Promise<components['schemas']['GetReferencedByResponse']> {
    return eventBusRequest(
      this.eventBus,
      'bind:referenced-by-requested',
      { correlationId: crypto.randomUUID(), resourceId, motivation },
      'bind:referenced-by-result',
      'bind:referenced-by-failed',
      this.timeoutMs,
    );
  }

  // ========================================================================
  // Mark Flow — Entity types
  // ========================================================================

  async listEntityTypes(): Promise<components['schemas']['GetEntityTypesResponse']> {
    return eventBusRequest(
      this.eventBus,
      'mark:entity-types-requested',
      { correlationId: crypto.randomUUID() },
      'mark:entity-types-result',
      'mark:entity-types-failed',
      this.timeoutMs,
    );
  }

  addEntityType(tag: string, userId: UserId): void {
    this.eventBus.get('mark:add-entity-type').next({ tag, userId });
  }

  // ========================================================================
  // Yield Flow — Clone tokens
  // ========================================================================

  async generateCloneToken(
    resourceId: ResourceId,
  ): Promise<components['schemas']['CloneResourceWithTokenResponse']> {
    return eventBusRequest(
      this.eventBus,
      'yield:clone-token-requested',
      { correlationId: crypto.randomUUID(), resourceId },
      'yield:clone-token-generated',
      'yield:clone-token-failed',
      this.timeoutMs,
    );
  }

  async getResourceByToken(
    token: string,
  ): Promise<components['schemas']['GetResourceByTokenResponse']> {
    return eventBusRequest(
      this.eventBus,
      'yield:clone-resource-requested',
      { correlationId: crypto.randomUUID(), token },
      'yield:clone-resource-result',
      'yield:clone-resource-failed',
      this.timeoutMs,
    );
  }

  async createResourceFromToken(options: {
    token: string;
    name: string;
    content: string;
    userId: UserId;
    archiveOriginal?: boolean;
  }): Promise<{ resourceId: ResourceId }> {
    return eventBusRequest(
      this.eventBus,
      'yield:clone-create',
      { correlationId: crypto.randomUUID(), ...options },
      'yield:clone-created',
      'yield:clone-create-failed',
      this.timeoutMs,
    );
  }

  // ========================================================================
  // Job Control
  // ========================================================================

  async getJobStatus(
    jobId: JobId,
  ): Promise<components['schemas']['JobStatusResponse']> {
    return eventBusRequest(
      this.eventBus,
      'job:status-requested',
      { correlationId: crypto.randomUUID(), jobId },
      'job:status-result',
      'job:status-failed',
      this.timeoutMs,
    );
  }

  // ========================================================================
  // Gather Flow — LLM context
  // ========================================================================

  async getAnnotationLLMContext(
    annotationId: string,
    resourceId: string,
    options?: {
      includeSourceContext?: boolean;
      includeTargetContext?: boolean;
      contextWindow?: number;
    },
  ): Promise<components['schemas']['AnnotationLLMContextResponse']> {
    const correlationId = crypto.randomUUID();

    const result$ = merge(
      this.eventBus.get('gather:complete').pipe(
        filter((e) => e.correlationId === correlationId),
        map((e) => ({ ok: true as const, response: e.response })),
      ),
      this.eventBus.get('gather:failed').pipe(
        filter((e) => e.correlationId === correlationId),
        map((e) => ({ ok: false as const, error: e.error })),
      ),
    ).pipe(take(1), timeout(this.timeoutMs));

    const resultPromise = firstValueFrom(result$);

    this.eventBus.get('gather:requested').next({
      correlationId,
      annotationId,
      resourceId,
      options,
    });

    const result = await resultPromise;
    if (!result.ok) {
      throw result.error;
    }
    return result.response;
  }

  async getResourceLLMContext(
    resourceId: string,
    options: {
      depth: number;
      maxResources: number;
      includeContent: boolean;
      includeSummary: boolean;
    },
  ): Promise<components['schemas']['ResourceLLMContextResponse']> {
    const correlationId = crypto.randomUUID();

    const result$ = merge(
      this.eventBus.get('gather:resource-complete').pipe(
        filter((e) => e.correlationId === correlationId),
        map((e) => ({ ok: true as const, response: e.context })),
      ),
      this.eventBus.get('gather:resource-failed').pipe(
        filter((e) => e.correlationId === correlationId),
        map((e) => ({ ok: false as const, error: e.error })),
      ),
    ).pipe(take(1), timeout(this.timeoutMs));

    const resultPromise = firstValueFrom(result$);

    this.eventBus.get('gather:resource-requested').next({
      correlationId,
      resourceId,
      options,
    });

    const result = await resultPromise;
    if (!result.ok) {
      throw result.error;
    }
    return result.response;
  }

  // ========================================================================
  // Bind Flow — Search
  // ========================================================================

  async searchResources(
    searchTerm: string,
  ): Promise<components['schemas']['ResourceDescriptor'][]> {
    const correlationId = crypto.randomUUID();
    const referenceId = correlationId; // reuse as referenceId

    const result$ = merge(
      this.eventBus.get('bind:search-results').pipe(
        filter((e) => e.correlationId === correlationId),
        map((e) => ({ ok: true as const, results: e.results })),
      ),
      this.eventBus.get('bind:search-failed').pipe(
        filter((e) => e.correlationId === correlationId),
        map((e) => ({ ok: false as const, error: e.error })),
      ),
    ).pipe(take(1), timeout(this.timeoutMs));

    const resultPromise = firstValueFrom(result$);

    this.eventBus.get('bind:search-requested').next({
      correlationId,
      referenceId,
      searchTerm,
    });

    const result = await resultPromise;
    if (!result.ok) {
      throw result.error;
    }
    return result.results;
  }
}
