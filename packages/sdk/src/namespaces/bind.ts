import type { ResourceId, AnnotationId, BodyOperation, EventBus, EventMap } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { busRequest } from '@semiont/core';
import type { BindNamespace as IBindNamespace } from './types';

export class BindNamespace implements IBindNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  async body(resourceId: ResourceId, annotationId: AnnotationId, operations: BodyOperation[]): Promise<void> {
    // Confirmed write: the bind handler forwards to mark:update-body, matches the
    // persisted outcome by correlationId, and replies on bind:body-updated /
    // bind:body-update-failed. busRequest awaits that real outcome and REJECTS
    // on failure — it is not an optimistic fire-and-forget ack. busRequest
    // mints the correlationId.
    await busRequest(
      this.transport,
      'bind:update-body',
      { annotationId, resourceId, operations },
    );
  }

  initiate(input: EventMap['bind:initiate']): void {
    // Local emit: resource-viewer-page-state-unit subscribes via the local bus.
    this.bus.emit('bind:initiate', input);
  }

  reportBodyError(input: EventMap['bind:body-error']): void {
    // Local emit: the client-local, resource-stamped UI notification for a
    // bind failure caught by a caller with no toast surface (ReferenceEntry's
    // unlink); useOutcomeToasts subscribes and surfaces it. Distinct from the
    // bind:body-update-failed wire reply, which is busRequest plumbing.
    this.bus.emit('bind:body-error', input);
  }
}
