/**
 * useBindFlow - Reference resolution flow hook
 *
 * Bridges EventBus commands to namespace API methods for bind operations.
 * Match search is handled by MatchVM (createMatchVM).
 *
 * Toast notifications for resolution errors remain here (React-specific).
 */

import type { ResourceId, AnnotationId } from '@semiont/core';
import { annotationId as makeAnnotationId } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useToast } from '../components/Toast';

export function useBindFlow(rUri: ResourceId): void {
  const semiont = useApiClient();
  const { showError } = useToast();

  useEventSubscriptions({
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
  });
}
