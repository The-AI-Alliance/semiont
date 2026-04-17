import type { AnnotationId, ResourceId } from '@semiont/core';
import type { ActorVM } from '../view-models/domain/actor-vm';
import type { BeckonNamespace as IBeckonNamespace } from './types';

export class BeckonNamespace implements IBeckonNamespace {
  constructor(
    private readonly actor: ActorVM,
  ) {}

  attention(annotationId: AnnotationId, resourceId: ResourceId): void {
    this.actor.emit('beckon:focus', { annotationId, resourceId }).catch(() => {});
  }
}
