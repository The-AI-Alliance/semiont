/**
 * useBindFlow - Reference resolution flow hook
 *
 * Bridges EventBus commands to namespace API methods.
 * Components emit bind:update-body / match:search-requested on the EventBus;
 * this hook calls client.bind.body() / client.match.search() in response.
 *
 * Toast notifications for resolution errors remain here (React-specific).
 */

import type { ResourceId, AnnotationId } from '@semiont/core';
import { annotationId as makeAnnotationId } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useToast } from '../components/Toast';

export function useBindFlow(rUri: ResourceId): void {
  const client = useApiClient();
  const { showError } = useToast();

  // Bridge bind:update-body EventBus events to client.bind.body()
  useEventSubscriptions({
    'bind:update-body': async (event) => {
      try {
        await client.bind.body(
          rUri,
          makeAnnotationId(event.annotationId) as AnnotationId,
          event.operations as Parameters<typeof client.bind.body>[2],
        );
      } catch (error) {
        showError(`Failed to update reference: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    'bind:body-update-failed': ({ message }) => showError(`Failed to update reference: ${message}`),
  });
}
