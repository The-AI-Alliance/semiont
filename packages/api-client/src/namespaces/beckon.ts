import type { AnnotationId, ResourceId } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { ActorVM } from '../view-models/domain/actor-vm';
import type { BeckonNamespace as IBeckonNamespace } from './types';

export class BeckonNamespace implements IBeckonNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly actor: ActorVM,
  ) {}

  attention(annotationId: AnnotationId, resourceId: ResourceId): void {
    this.actor.emit('beckon:focus', { annotationId, resourceId }).catch(() => {});
  }

  hover(annotationId: AnnotationId | null): void {
    // Local emit: beckon-vm subscribes via `client.stream` (local bus).
    this.http.emit('beckon:hover', { annotationId });
  }

  sparkle(annotationId: AnnotationId): void {
    this.http.emit('beckon:sparkle', { annotationId });
  }
}
