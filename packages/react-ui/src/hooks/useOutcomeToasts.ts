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
 *     here would say the assist had failed while its annotations are
 *     still on their way.)
 *   job:complete                                                     → success,
 *     except a clean decline (e.g. a scanned/image-only PDF with no text
 *     layer, #736/#738) → info: a decline is a valid no-op, neither a
 *     success (nothing was detected) nor a failure (nothing broke).
 *
 * **Every string here is localized.** Decline copy is keyed on the wire's
 * `reason` CODE — the launcher renders the same codes as English terminal
 * copy, which is correct for a CLI and is exactly why the wire must not carry
 * a sentence.
 *
 * Every subscribed channel is filtered to `resourceId`, so N mounted
 * viewers each toast only their own resource's outcomes.
 *
 * Deliberately NOT subscribed: the `*-failed` wire reply channels
 * (`mark:create-failed`, `mark:delete-failed`, `bind:body-update-failed`).
 * Those carry `CommandError` and are busRequest correlation plumbing: a
 * reply reaches only the client that made the request, where busRequest
 * matches it by correlationId — toasting it raw as well would toast the
 * requester twice. The UI-facing counterparts are the client-local `*-error`
 * events above, emitted by the awaiting catch (mark-state-unit;
 * ResourceViewer's delete; ReferenceEntry's unlink), which knows which
 * resource the command failed on. Awaiting callers with their own toast
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
      // still land. The client has merely stopped hearing from it, so this
      // is an advisory, not an error.
      showInfo(t('assistQuiet'));
    },
    'job:complete': (event) => {
      if (event.resourceId !== resourceId) return;
      // The union discriminates: the result names its own kind, so no cast and
      // no reliance on the envelope's jobType to know what arrived.
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
      } else if (event.result?.kind === 'reference-annotation' && event.result.underReportedPieces !== undefined) {
        // A partial run, reported on the ephemeral surface: the run finished
        // but the count-verifier accepted under-reported pieces. Info, not
        // success — and only when the wire SAYS so: absence is the emitter's
        // mutation-proven claim of cleanliness, never re-derived here.
        showInfo(t('annotationCompletePartial', { pieces: event.result.underReportedPieces }));
      } else {
        showSuccess(t('annotationComplete'));
      }
    },
    'job:fail': (event) => {
      if (event.resourceId !== resourceId) return;
      // A failure the queue will retry is "a setback, not an ending": the run
      // continues on a fresh attempt and the progress display stays live. An
      // error toast here would report a recovering run as a failed one.
      if (event.willRetry === true) return;
      if (event.jobType === 'generation') {
        showError(t('generationFailed', { detail: event.error }));
      } else if (event.completedUnits && event.completedUnits.length > 0) {
        // The terminal failure left durable finds standing (partial results
        // STAND — they are never retracted). Say so, so the annotations on
        // screen are not mistaken for a complete run's.
        showError(t('annotationFailedPartial', { kept: event.completedUnits.length }));
      } else {
        showError(event.error || t('annotationFailed'));
      }
    },
  });
}
