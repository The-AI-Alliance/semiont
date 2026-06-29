import type { ResourceId, AnnotationId, BodyOperation, EventBus, EventMap } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { busRequest } from '../bus-request';
import type { BindNamespace as IBindNamespace } from './types';

export class BindNamespace implements IBindNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  async body(resourceId: ResourceId, annotationId: AnnotationId, operations: BodyOperation[]): Promise<void> {
    // Confirmed write: the bind handler forwards to mark:update-body, matches the
    // persisted outcome by correlationId, and replies on bind:body-updated /
    // bind:body-update-failed (the handler is already built for this). busRequest
    // awaits that real outcome and REJECTS on failure — not the old optimistic
    // fire-and-forget ack (.plans/bugs/BRIDGE-GAPS.md). busRequest mints the
    // correlationId, so we no longer set one by hand.
    await busRequest<void>(
      this.transport,
      'bind:update-body',
      { annotationId, resourceId, operations },
      'bind:body-updated',
      'bind:body-update-failed',
    );
  }

  initiate(input: EventMap['bind:initiate']): void {
    // Local emit: resource-viewer-page-state-unit subscribes via the local bus.
    this.bus.get('bind:initiate').next(input);
  }
}
