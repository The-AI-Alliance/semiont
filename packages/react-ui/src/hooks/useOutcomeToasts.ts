import type { components } from '@semiont/core';
import { useToast } from '../components/Toast';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { declinedMessage } from '../lib/job-outcome';

/**
 * Toasts for domain **outcome** events on a resource — the complete set of
 * pure event→notification mappings the resource viewer chrome owns:
 *
 *   mark:create-failed / mark:delete-failed / bind:body-update-failed → error
 *   job:fail                                                         → error
 *   mark:assist-timeout                                              → error
 *     (a client-side timeout: the assist went silent, so no job:fail
 *     ever fires — this is the only notification the user gets)
 *   job:complete                                                     → success,
 *     except a clean decline (e.g. a scanned/image-only PDF with no text
 *     layer, #736/#738) → info: a decline is a valid no-op, neither a
 *     success (nothing was detected) nor a failure (nothing broke).
 *   mark:assist-cancelled                                            → info
 *
 * This is deliberately the whole seam: these channels need only the
 * resource id and the toast surface — no SDK client, no navigation, no
 * page state — which is what separates them from the page's other
 * subscriptions (actions, sparkles, settings, navigation).
 *
 * `job:complete`/`job:fail`/`mark:assist-timeout` are filtered to
 * `resourceId`; the mark/bind failure channels carry no resource id and are
 * session-wide (pre-existing behavior — with N mounted viewers each one
 * toasts).
 */
export function useOutcomeToasts(resourceId: string): void {
  const { showError, showSuccess, showInfo } = useToast();

  useEventSubscriptions({
    'mark:create-failed': ({ message }) =>
      showError(`Failed to create annotation: ${message || 'unknown error'}`),
    'mark:delete-failed': ({ message }) =>
      showError(`Failed to delete annotation: ${message || 'unknown error'}`),
    'bind:body-update-failed': ({ message }) =>
      showError(`Failed to update reference: ${message}`),
    'mark:assist-cancelled': () => showInfo('Annotation cancelled'),
    'mark:assist-timeout': (event) => {
      if (event.resourceId !== resourceId) return;
      showError('Annotation assist timed out');
    },
    'job:complete': (event) => {
      if (event.resourceId !== resourceId) return;
      if (event.jobType === 'generation') {
        const result = event.result as components['schemas']['JobGenerationResult'] | undefined;
        const name = result?.resourceName;
        showSuccess(name
          ? `Resource "${name}" created successfully!`
          : 'Resource created successfully!');
        return;
      }
      const declined = declinedMessage(event.result);
      if (declined) {
        showInfo(declined);
      } else {
        showSuccess('Annotation complete');
      }
    },
    'job:fail': (event) => {
      if (event.resourceId !== resourceId) return;
      if (event.jobType === 'generation') {
        showError(`Resource generation failed: ${event.error}`);
      } else {
        showError(event.error || 'Annotation failed');
      }
    },
  });
}
