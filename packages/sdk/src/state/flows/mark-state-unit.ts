import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { ResourceId, Motivation, Selector, EventMap, components } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '@semiont/core';

type JobProgress = components['schemas']['JobProgress'];

/**
 * How long the client waits for ANY emission before telling the user the job
 * has gone quiet. Not a deadline on the job — see the silence detector in
 * `createMarkStateUnit`. Sized above the worker's ~15 s in-flight heartbeat
 * (DETECTION-HEARTBEAT), so reaching it means real silence, not a long call.
 */
export const ASSIST_SILENCE_MS = 180_000;

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

  // A finished run STAYS on screen (CLEAN-PROGRESS D1). There is no dismissal
  // timer: the result line — "Created 7 references" — is the one thing in the
  // whole run worth reading, and a timer that eats it is why the generation
  // flow felt like it vanished mid-sentence. The ended display carries an
  // explicit Close control; it clears on that, on `mark:progress-dismiss`, or
  // when the next assist replaces it below.

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
      // Client-local, resource-stamped UI notification — the wire reply
      // (mark:create-failed) is busRequest plumbing, not for UI consumption.
      client.bus.get('mark:create-error').next({ resourceId: resourceId as string, message: error instanceof Error ? error.message : String(error) });
    }
  }));

  subs.push(client.bus.get('mark:delete').subscribe(async (event) => {
    try {
      await client.mark.delete(resourceId, event.annotationId as Parameters<typeof client.mark.delete>[1]);
      client.bus.get('mark:delete-ok').next({ response: { annotationId: event.annotationId } });
    } catch (error) {
      client.bus.get('mark:delete-error').next({ resourceId: resourceId as string, message: error instanceof Error ? error.message : String(error) });
    }
  }));

  // AI assist. The assist() Observable encapsulates the full job
  // lifecycle — it subscribes to job:report-progress/complete/fail
  // filtered by its own jobId, emits JobProgress on `next`, completes
  // on `job:complete`, errors on `job:fail`. mark-state-unit's only job is to
  // drive the three UI observables from that stream.
  subs.push(client.bus.get('mark:assist-request').subscribe((event) => {
    assistingMotivation$.next(event.motivation);
    progress$.next(null);

    // Silence detector, NOT a timeout (DETECTION-HEARTBEAT D6). The job
    // outlives the client's attention: a run the UI gave up on still
    // persisted 221 annotations (2026-08-07). So going quiet must degrade
    // the display — never tear the subscription down, which would leave the
    // real completion with nothing to resolve, and never claim the assist
    // ended while the worker is still working.
    //
    // Post-heartbeat (workers emit every ~15 s while a call is in flight),
    // reaching this window means the worker really has gone quiet — so the
    // signal is kept, and only its meaning is corrected.
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStale = () => {
      if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
    };
    const armStale = () => {
      clearStale();
      staleTimer = setTimeout(() => {
        staleTimer = null;
        const last = progress$.getValue();
        // No prose here: the wire (and this state unit's output) carries
        // codes, not sentences, and the stale notice is the UI's copy to
        // own — it hears about the silence via `mark:assist-timeout` below.
        progress$.next({
          ...(last ?? {}),
          percentage: last?.percentage ?? 0,
        });
        // The one notification the user gets. `assistingMotivation$` stays
        // set: the job is still running as far as anyone here knows.
        client.bus.get('mark:assist-timeout').next({
          resourceId: resourceId as string,
          motivation: event.motivation,
        });
      }, ASSIST_SILENCE_MS);
    };
    armStale();

    const assistSub = client.mark.assist(resourceId, event.motivation, event.options).subscribe({
      next: (e) => {
        armStale();
        // Surface only the live progress events to the UI; the final
        // `complete` event carries `result` for callers awaiting the
        // Observable, but the panel just dismisses on `complete`. Terminal
        // outcomes (success / clean decline / failure) are surfaced as toasts
        // by useOutcomeToasts (react-ui), which subscribes job:complete /
        // job:fail directly — not through this Observable.
        if (e.kind === 'progress') progress$.next(e.data);
      },
      complete: () => {
        // Resolves the UI whenever it arrives — including long after the
        // silence marker, which is the whole point of not tearing down.
        // `assistingMotivation$` going null is what flips the display to its
        // ended form; the payload is left in place for the user to read.
        clearStale();
        assistingMotivation$.next(null);
      },
      error: () => {
        // A real failure: `job:fail` already toasts it through the outcome
        // channel, so clear the assist state and stay quiet here.
        clearStale();
        assistingMotivation$.next(null);
        progress$.next(null);
      },
    });
    subs.push(assistSub);
  }));

  subs.push(client.bus.get('mark:progress-dismiss').subscribe(() => {
    progress$.next(null);
  }));

  return {
    pendingAnnotation$: pendingAnnotation$.asObservable(),
    assistingMotivation$: assistingMotivation$.asObservable(),
    progress$: progress$.asObservable(),
    dispose() {
      subs.forEach(s => s.unsubscribe());
      pendingAnnotation$.complete();
      assistingMotivation$.complete();
      progress$.complete();
    },
  };
}
