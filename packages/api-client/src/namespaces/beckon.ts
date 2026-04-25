import type { AnnotationId, EventBus, ResourceId } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import type { BeckonNamespace as IBeckonNamespace } from './types';

export class BeckonNamespace implements IBeckonNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  attention(annotationId: AnnotationId, resourceId: ResourceId): void {
    void this.transport.emit('beckon:focus', { annotationId, resourceId });
  }

  hover(annotationId: AnnotationId | null): void {
    // Local emit: beckon-vm subscribes via the local bus.
    this.bus.get('beckon:hover').next({ annotationId });
  }

  sparkle(annotationId: AnnotationId): void {
    this.bus.get('beckon:sparkle').next({ annotationId });
  }
}
