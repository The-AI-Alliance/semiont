import type { components } from '@semiont/core';
import { useToast } from '../components/Toast';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { declinedMessage } from '../lib/job-outcome';

/**
 * Toasts for domain **outcome** events on a resource — the complete set of
 * pure event→notification mappings the resource viewer chrome owns:
 *
 *   mark:create-error / mark:delete-error / bind:body-error          → error
 *   job:fail                                                         → error
 *   mark:assist-timeout                                              → error
 *     (a client-side timeout: the assist went silent, so no job:fail
 *     ever fires — this is the only notification the user gets)
 *   job:complete                                                     → success,
 *     except a clean decline (e.g. a scanned/image-only PDF with no text
 *     layer, #736/#738) → info: a decline is a valid no-op, neither a
 *     success (nothing was detected) nor a failure (nothing broke).
 *
 * Every subscribed channel is filtered to `resourceId`, so N mounted
 * viewers each toast only their own resource's outcomes.
 *
 * Deliberately NOT subscribed: the `*-failed` wire reply channels
 * (`mark:create-failed`, `mark:delete-failed`, `bind:body-update-failed`).
 * Those carry `CommandError` and are busRequest correlation plumbing,
 * bridged to every connected client — toasting them raw double-toasts the
 * requester and leaks other users' failures. The UI-facing counterparts are
 * the client-local `*-error` events above, emitted by the awaiting catch
 * (mark-state-unit; ReferenceEntry's unlink), which inherently knows whose
 * command failed on which resource. Awaiting callers with their own toast
 * surface (the reference wizard, the compose save flow) surface failures
 * themselves instead.
 *
 * This is deliberately the whole seam: these channels need only the
 * resource id and the toast surface — no SDK client, no navigation, no
 * page state — which is what separates them from the page's other
 * subscriptions (actions, sparkles, settings, navigation).
 */
export function useOutcomeToasts(resourceId: string): void {
  const { showError, showSuccess, showInfo } = useToast();

  useEventSubscriptions({
    'mark:create-error': (event) => {
      if (event.resourceId !== resourceId) return;
      showError(`Failed to create annotation: ${event.message || 'unknown error'}`);
    },
    'mark:delete-error': (event) => {
      if (event.resourceId !== resourceId) return;
      showError(`Failed to delete annotation: ${event.message || 'unknown error'}`);
    },
    'bind:body-error': (event) => {
      if (event.resourceId !== resourceId) return;
      showError(`Failed to update reference: ${event.message || 'unknown error'}`);
    },
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
