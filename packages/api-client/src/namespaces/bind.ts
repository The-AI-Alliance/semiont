import type { ResourceId, AnnotationId, BodyOperation } from '@semiont/core';
import type { ActorVM } from '../view-models/domain/actor-vm';
import type { BindNamespace as IBindNamespace } from './types';

export class BindNamespace implements IBindNamespace {
  constructor(
    private readonly actor: ActorVM,
  ) {}

  async body(resourceId: ResourceId, annotationId: AnnotationId, operations: BodyOperation[]): Promise<void> {
    await this.actor.emit('bind:initiate', {
      correlationId: crypto.randomUUID(),
      annotationId,
      resourceId,
      operations,
    });
  }
}
