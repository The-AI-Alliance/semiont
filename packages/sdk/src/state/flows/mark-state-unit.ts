import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { isObject, isString } from '@semiont/core';
import type { ResourceId, Motivation, Selector, EventMap, components } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '@semiont/core';

type JobProgress = components['schemas']['JobProgress'];

/**
 * A detection job that declined cleanly rather than erroring — today a
 * scanned / image-only PDF with no text layer to analyze (#736/#738). The
 * worker reports it as the job result; it is not in the typed `JobResult`
 * union, so narrow it structurally. Returns the user-facing message, or null.
 */
function declinedMessage(result: unknown): string | null {
  return isObject(result) && result.declined === true && isString(result.message)
    ? result.message
    : null;
}

export interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface MarkStateUnit extends StateUnit {
  pendingAnnotation$: Observable<PendingAnnotation | null>;
  assistingMotivation$: Observable<Motivation | null>;
  progress$: Observable<JobProgress | null>;
}

type SelectionData = EventMap['mark:select-comment'];

function selectionToSelector(selection: SelectionData): Selector | Selector[] {
  if (selection.svgSelector) return { type: 'SvgSelector', value: selection.svgSelector };
  if (selection.fragmentSelector) {
    const selectors: Selector[] = [{ type: 'FragmentSelector', value: selection.fragmentSelector, ...(selection.conformsTo && { conformsTo: selection.conformsTo }) }];
    if (selection.exact) selectors.push({ type: 'TextQuoteSelector', exact: selection.exact, ...(selection.prefix && { prefix: selection.prefix }), ...(selection.suffix && { suffix: selection.suffix }) });
    return selectors;
  }
  return { type: 'TextQuoteSelector', exact: selection.exact, ...(selection.prefix && { prefix: selection.prefix }), ...(selection.suffix && { suffix: selection.suffix }) };
}

export function createMarkStateUnit(
  client: SemiontClient,
  resourceId: ResourceId,
): MarkStateUnit {
  const subs: Subscription[] = [];
  const pendingAnnotation$ = new BehaviorSubject<PendingAnnotation | null>(null);
  const assistingMotivation$ = new BehaviorSubject<Motivation | null>(null);
  const progress$ = new BehaviorSubject<JobProgress | null>(null);
  let progressDismissTimer: ReturnType<typeof setTimeout> | null = null;

  const clearProgressTimer = () => {
    if (progressDismissTimer) { clearTimeout(progressDismissTimer); progressDismissTimer = null; }
  };

  // The view layer is responsible for opening the annotations panel in
  // response to `pendingAnnotation$` becoming non-null. The state unit stays pure:
  // it updates state; UI side-effects (opening panels on the app-scoped
  // bus) belong in the view layer, where the host's bus emit is accessible.
  const handleAnnotationRequested = (pending: PendingAnnotation) => {
    pendingAnnotation$.next(pending);
  };

  // Selection events → pending annotation. `mark:requested` / `mark:submit`
  // carry their source resource id and this unit handles only its own — N
  // units on one client (multi-viewer hosts) must not cross-fire.
  // NOTE: the `mark:select-*` quick-popup events remain unscoped — their only
  // emitters are the Browser's single-page popups; scope them the same way if
  // they ever grow multi-viewer emitters.
  subs.push(client.bus.get('mark:requested').subscribe((event) => {
    if (event.source !== resourceId) return;
    handleAnnotationRequested({ selector: event.selector as Selector | Selector[], motivation: event.motivation });
  }));
  subs.push(client.bus.get('mark:select-comment').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'commenting' })));
  subs.push(client.bus.get('mark:select-tag').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'tagging' })));
  subs.push(client.bus.get('mark:select-assessment').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'assessing' })));
  subs.push(client.bus.get('mark:select-reference').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'linking' })));

  subs.push(client.bus.get('mark:cancel-pending').subscribe(() => pendingAnnotation$.next(null)));
  subs.push(client.bus.get('mark:create-ok').subscribe(() => pendingAnnotation$.next(null)));

  // CRUD bridging (submit routed by source — see note above)
  subs.push(client.bus.get('mark:submit').subscribe(async (event) => {
    if (event.source !== resourceId) return;
    try {
      const result = await client.mark.annotation({
        motivation: event.motivation,
        target: { source: resourceId, selector: event.selector as Selector },
        body: event.body,
      });
      client.bus.get('mark:create-ok').next({ response: { annotationId: result.annotationId } });
    } catch (error) {
      client.bus.get('mark:create-failed').next({ message: error instanceof Error ? error.message : String(error) });
    }
  }));

  subs.push(client.bus.get('mark:delete').subscribe(async (event) => {
    try {
      await client.mark.delete(resourceId, event.annotationId as Parameters<typeof client.mark.delete>[1]);
      client.bus.get('mark:delete-ok').next({ response: { annotationId: event.annotationId } });
    } catch (error) {
      client.bus.get('mark:delete-failed').next({ message: error instanceof Error ? error.message : String(error) });
    }
  }));

  // AI assist. The assist() Observable encapsulates the full job
  // lifecycle — it subscribes to job:report-progress/complete/fail
  // filtered by its own jobId, emits JobProgress on `next`, completes
  // on `job:complete`, errors on `job:fail`. mark-state-unit's only job is to
  // drive the three UI observables from that stream.
  subs.push(client.bus.get('mark:assist-request').subscribe((event) => {
    clearProgressTimer();
    assistingMotivation$.next(event.motivation);
    progress$.next(null);

    // When a job declines cleanly (e.g. a scanned PDF with no text layer), the
    // final `complete` event carries the reason. Hold it so `complete` leaves
    // the message up instead of the usual auto-dismiss.
    let declineMessage: string | null = null;
    const assistSub = client.mark.assist(resourceId, event.motivation, event.options).pipe(
      timeout({ each: 180_000 }),
    ).subscribe({
      next: (e) => {
        // Live progress events drive the spinner. The final `complete` event
        // carries `result`: a normal completion just dismisses, but a clean
        // decline (scanned/image-only PDF) surfaces its message here — otherwise
        // the panel vanishes with zero annotations and no explanation.
        if (e.kind === 'progress') {
          progress$.next(e.data);
          return;
        }
        declineMessage = declinedMessage(e.data.result);
        if (declineMessage) {
          progress$.next({ stage: 'declined', percentage: 100, message: declineMessage });
        }
      },
      complete: () => {
        assistingMotivation$.next(null);
        clearProgressTimer();
        // A decline message stays until the user dismisses it
        // (mark:progress-dismiss); a normal completion auto-dismisses.
        if (declineMessage) return;
        progressDismissTimer = setTimeout(() => {
          progress$.next(null);
          progressDismissTimer = null;
        }, 5000);
      },
      error: () => {
        clearProgressTimer();
        assistingMotivation$.next(null);
        progress$.next(null);
      },
    });
    subs.push(assistSub);
  }));

  subs.push(client.bus.get('mark:progress-dismiss').subscribe(() => {
    clearProgressTimer();
    progress$.next(null);
  }));

  return {
    pendingAnnotation$: pendingAnnotation$.asObservable(),
    assistingMotivation$: assistingMotivation$.asObservable(),
    progress$: progress$.asObservable(),
    dispose() {
      subs.forEach(s => s.unsubscribe());
      clearProgressTimer();
      pendingAnnotation$.complete();
      assistingMotivation$.complete();
      progress$.complete();
    },
  };
}
