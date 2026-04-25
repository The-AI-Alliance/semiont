import type { ResourceId, AnnotationId, BodyOperation, EventBus, EventMap } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import type { BindNamespace as IBindNamespace } from './types';

export class BindNamespace implements IBindNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  async body(resourceId: ResourceId, annotationId: AnnotationId, operations: BodyOperation[]): Promise<void> {
    await this.transport.emit('bind:update-body', {
      correlationId: crypto.randomUUID(),
      annotationId,
      resourceId,
      operations,
    });
  }

  initiate(input: EventMap['bind:initiate']): void {
    // Local emit: resource-viewer-page-vm subscribes via the local bus.
    this.bus.get('bind:initiate').next(input);
  }
}
