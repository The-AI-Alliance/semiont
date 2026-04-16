import type { Subscription } from 'rxjs';
import type { EventBus, ResourceId, AnnotationId } from '@semiont/core';
import { annotationId as makeAnnotationId } from '@semiont/core';
import type { SemiontApiClient } from '../../client';
import type { ViewModel } from '../lib/view-model';

export interface BindVM extends ViewModel {}

export function createBindVM(
  client: SemiontApiClient,
  eventBus: EventBus,
  resourceId: ResourceId,
): BindVM {
  const subs: Subscription[] = [];

  subs.push(eventBus.get('bind:update-body').subscribe(async (event) => {
    try {
      await client.bind.body(
        resourceId,
        makeAnnotationId(event.annotationId) as AnnotationId,
        event.operations as Parameters<typeof client.bind.body>[2],
      );
    } catch (error) {
      eventBus.get('bind:body-update-failed').next({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  return {
    dispose() {
      subs.forEach(s => s.unsubscribe());
    },
  };
}
