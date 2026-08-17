import { useToast } from '../components/Toast';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { declineReason } from '../lib/job-outcome';
import { useTranslations } from '../contexts/TranslationContext';

/**
 * Toasts for domain **outcome** events on a resource — the complete set of
 * pure event→notification mappings the resource viewer chrome owns:
 *
 *   mark:create-error / mark:delete-error / bind:body-error          → error
 *   job:fail                                                         → error
 *   mark:assist-timeout                                              → info
 *     (the assist went SILENT, not wrong: no job:fail ever fires and the
 *     worker keeps going, so this is an advisory — the only notification
 *     the user gets that the client has stopped hearing. An error toast
 *     here said the assist had failed while its annotations were still
 *     on their way.)
 *   job:complete                                                     → success,
 *     except a clean decline (e.g. a scanned/image-only PDF with no text
 *     layer, #736/#738) → info: a decline is a valid no-op, neither a
 *     success (nothing was detected) nor a failure (nothing broke).
 *
 * **Every string here is localized** (ASSIST-PROGRESS-CONSOLIDATION P5). This
 * hook previously rendered eight English literals and read `useTranslations`
 * zero times, so every toast in the resource viewer was English in all 29
 * locales. Decline copy is keyed on the wire's `reason` CODE — the launcher
 * renders the same codes as English terminal copy, which is correct for a CLI
 * and is exactly why the wire must not carry a sentence.
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
  const t = useTranslations('OutcomeToasts');
  const { showError, showSuccess, showInfo } = useToast();

  useEventSubscriptions({
    'mark:create-error': (event) => {
      if (event.resourceId !== resourceId) return;
      showError(t('createFailed', { detail: event.message || t('unknownError') }));
    },
    'mark:delete-error': (event) => {
      if (event.resourceId !== resourceId) return;
      showError(t('deleteFailed', { detail: event.message || t('unknownError') }));
    },
    'bind:body-error': (event) => {
      if (event.resourceId !== resourceId) return;
      showError(t('referenceUpdateFailed', { detail: event.message || t('unknownError') }));
    },
    'mark:assist-timeout': (event) => {
      if (event.resourceId !== resourceId) return;
      // NOT a failure: the job is still running and its annotations will
      // still land (proven live — a run the UI gave up on persisted 221).
      // The client has merely stopped hearing from it, so this is an
      // advisory, not an error (DETECTION-HEARTBEAT Phase B).
      showInfo(t('assistQuiet'));
    },
    'job:complete': (event) => {
      if (event.resourceId !== resourceId) return;
      // The union discriminates (WIRE-UNION-DISCRIMINANTS D1): the result
      // names its own kind, so no cast and no reliance on the envelope's
      // jobType to know what arrived.
      if (event.result?.kind === 'generation') {
        showSuccess(event.result.resourceName
          ? t('resourceCreatedNamed', { name: event.result.resourceName })
          : t('resourceCreated'));
        return;
      }
      const reason = declineReason(event.result);
      if (reason) {
        // `decline_no-text-layer` etc. — the code IS the key suffix, so a new
        // reason on the wire needs copy and the translations gate says so.
        showInfo(t(`decline_${reason}`));
      } else {
        showSuccess(t('annotationComplete'));
      }
    },
    'job:fail': (event) => {
      if (event.resourceId !== resourceId) return;
      if (event.jobType === 'generation') {
        showError(t('generationFailed', { detail: event.error }));
      } else {
        showError(event.error || t('annotationFailed'));
      }
    },
  });
}
