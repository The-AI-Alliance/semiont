import type {
  ResourceId,
  AnnotationId,
  Motivation,
  EventBus,
  EventMap,
  MarkJobParams,
  components,
} from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { busRequest } from '@semiont/core';
import type { DelegationObservable } from '../awaitable';
import { delegated } from './delegation';
import type { JobFollowTiming } from './job-status-poll';
import type {
  MarkNamespace as IMarkNamespace,
  CreateAnnotationInput,
} from './types';

export class MarkNamespace implements IMarkNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
    private readonly timing: JobFollowTiming = {},
  ) {}

  async annotation(input: CreateAnnotationInput): Promise<{ annotationId: AnnotationId }> {
    // The wire schema (`MarkCreateRequest`) carries `resourceId` separately
    // for routing — we derive it from `input.target.source`, which is the
    // same value semantically.
    const resourceId = input.target.source;
    const result = await busRequest(
      this.transport,
      'mark:create-request',
      { resourceId, request: input },
    );
    return { annotationId: result.annotationId };
  }

  async delete(resourceId: ResourceId, annotationId: AnnotationId): Promise<void> {
    // Confirmed write (matches `annotation()` above): await the
    // correlation-keyed reply and REJECT on failure, rather than fire-and-forget
    // an emit whose mark:delete-failed nobody awaits.
    await busRequest(
      this.transport,
      'mark:delete',
      { annotationId, resourceId },
    );
  }

  async archive(resourceId: ResourceId): Promise<void> {
    // Confirmed write: await the correlation-keyed reply and REJECT on failure,
    // rather than fire-and-forget an emit whose failure has nowhere to go.
    await busRequest(
      this.transport,
      'mark:archive',
      { resourceId },
    );
  }

  async unarchive(resourceId: ResourceId): Promise<void> {
    await busRequest(
      this.transport,
      'mark:unarchive',
      { resourceId },
    );
  }

  /**
   * Replace a resource's own entity-type classification. The Archivist diffs
   * `current` vs `updated` and folds the changes into `resource.entityTypes`
   * (mark:entity-tag-added/-removed → Weaver), so the change surfaces in
   * `browse.resources({ entityType })` and `getResourceEntityTypes`. A
   * **replace/diff** operation: pass the resource's current types as `current`,
   * the desired full set as `updated`.
   *
   * Confirmed write (like `delete`/`archive`): awaits the correlation-keyed
   * reply and REJECTS on failure rather than fire-and-forget an emit whose
   * failure has nowhere to go.
   */
  async updateEntityTypes(resourceId: ResourceId, current: string[], updated: string[]): Promise<void> {
    await busRequest(
      this.transport,
      'mark:update-entity-types',
      { resourceId, currentEntityTypes: current, updatedEntityTypes: updated },
    );
  }

  delegate(resourceId: ResourceId, params: MarkJobParams): DelegationObservable {
    return delegated(this.transport, this.bus, this.timing, { jobType: 'mark', resourceId, params }, resourceId);
  }

  request(
    source: ResourceId,
    selector: components['schemas']['MarkRequestedEvent']['selector'],
    motivation: Motivation,
  ): void {
    // Local emit: mark-state-unit subscribes via the local bus and routes by
    // `source` — resource-first, like every other mark.* method.
    this.bus.emit('mark:requested', { source, selector, motivation });
  }

  requestAssist(params: MarkJobParams): void {
    this.bus.emit('mark:assist-request', { params });
  }

  submit(input: components['schemas']['MarkSubmitEvent']): void {
    this.bus.emit('mark:submit', input);
  }

  cancelPending(): void {
    this.bus.emit('mark:cancel-pending', undefined);
  }

  dismissProgress(): void {
    this.bus.emit('mark:progress-dismiss', undefined);
  }

  reportDeleteError(input: EventMap['mark:delete-error']): void {
    // Local emit: the client-local, resource-stamped UI notice for a delete
    // that failed at the caller that awaited it (the viewer, which may be
    // embedded with no state unit mounted); useOutcomeToasts subscribes and
    // surfaces it. Distinct from the mark:delete-failed wire reply, which is
    // busRequest plumbing.
    this.bus.emit('mark:delete-error', input);
  }
}
