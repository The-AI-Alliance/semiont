import type { ResourceId, AnnotationId, BodyOperation, components } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { ActorVM } from '../view-models/domain/actor-vm';
import type { BindNamespace as IBindNamespace } from './types';

export class BindNamespace implements IBindNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly actor: ActorVM,
  ) {}

  async body(resourceId: ResourceId, annotationId: AnnotationId, operations: BodyOperation[]): Promise<void> {
    await this.actor.emit('bind:update-body', {
      correlationId: crypto.randomUUID(),
      annotationId,
      resourceId,
      operations,
    });
  }

  initiate(input: components['schemas']['BindInitiateCommand']): void {
    // Local emit: resource-viewer-page-vm subscribes via `client.stream`.
    this.http.emit('bind:initiate', input);
  }
}
