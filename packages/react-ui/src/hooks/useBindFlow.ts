/**
 * useBindFlow - Reference resolution flow hook
 *
 * Bridges EventBus commands to namespace API methods.
 * Components emit bind:update-body / match:search-requested on the EventBus;
 * this hook calls semiont.bind.body() / semiont.match.search() in response.
 *
 * Toast notifications for resolution errors remain here (React-specific).
 */

import type { ResourceId, AnnotationId, GatheredContext } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useEventBus } from '../contexts/EventBusContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useToast } from '../components/Toast';

export function useBindFlow(rUri: ResourceId): void {
  const semiont = useApiClient();
  const eventBus = useEventBus();
  const { showError } = useToast();

  useEventSubscriptions({
    // Bridge bind:update-body to semiont.bind.body()
    'bind:update-body': async (event) => {
      try {
        await semiont.bind.body(
          rUri,
          makeAnnotationId(event.annotationId) as AnnotationId,
          event.operations as Parameters<typeof semiont.bind.body>[2],
        );
      } catch (error) {
        showError(`Failed to update reference: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    'bind:body-update-failed': ({ message }) => showError(`Failed to update reference: ${message}`),

    // Bridge match:search-requested to semiont.match.search() Observable
    'match:search-requested': (event) => {
      semiont.match.search(
        makeResourceId(event.resourceId),
        event.referenceId,
        event.context as GatheredContext,
        { limit: event.limit, useSemanticScoring: event.useSemanticScoring },
      ).subscribe({
        next: (result) => eventBus.get('match:search-results').next(result),
        error: (err) => eventBus.get('match:search-failed').next({
          correlationId: event.correlationId,
          referenceId: event.referenceId,
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    },
  });
}
