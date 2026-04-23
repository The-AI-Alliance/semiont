import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import type { ResourceId, Motivation, Selector, EventMap, components } from '@semiont/core';
import type { SemiontApiClient } from '../../client';
import type { ViewModel } from '../lib/view-model';

type JobProgress = components['schemas']['JobProgress'];

export interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface MarkVM extends ViewModel {
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

export function createMarkVM(
  client: SemiontApiClient,
  resourceId: ResourceId,
): MarkVM {
  const subs: Subscription[] = [];
  const pendingAnnotation$ = new BehaviorSubject<PendingAnnotation | null>(null);
  const assistingMotivation$ = new BehaviorSubject<Motivation | null>(null);
  const progress$ = new BehaviorSubject<JobProgress | null>(null);
  let progressDismissTimer: ReturnType<typeof setTimeout> | null = null;

  const clearProgressTimer = () => {
    if (progressDismissTimer) { clearTimeout(progressDismissTimer); progressDismissTimer = null; }
  };

  // The view layer is responsible for opening the annotations panel in
  // response to `pendingAnnotation$` becoming non-null. The VM stays pure:
  // it updates state; UI side-effects (opening panels on the browser-scoped
  // bus) live where the React tree has access to `useSemiont().emit(...)`.
  const handleAnnotationRequested = (pending: PendingAnnotation) => {
    pendingAnnotation$.next(pending);
  };

  // Selection events → pending annotation
  subs.push(client.stream('mark:requested').subscribe(handleAnnotationRequested));
  subs.push(client.stream('mark:select-comment').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'commenting' })));
  subs.push(client.stream('mark:select-tag').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'tagging' })));
  subs.push(client.stream('mark:select-assessment').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'assessing' })));
  subs.push(client.stream('mark:select-reference').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'linking' })));

  subs.push(client.stream('mark:cancel-pending').subscribe(() => pendingAnnotation$.next(null)));
  subs.push(client.stream('mark:create-ok').subscribe(() => pendingAnnotation$.next(null)));

  // CRUD bridging
  subs.push(client.stream('mark:submit').subscribe(async (event) => {
    try {
      const result = await client.mark.annotation(resourceId, {
        motivation: event.motivation,
        target: { source: resourceId, selector: event.selector as Selector },
        body: event.body,
      });
      client.emit('mark:create-ok', { annotationId: result.annotationId });
    } catch (error) {
      client.emit('mark:create-failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }));

  subs.push(client.stream('mark:delete').subscribe(async (event) => {
    try {
      await client.mark.delete(resourceId, event.annotationId as Parameters<typeof client.mark.delete>[1]);
      client.emit('mark:delete-ok', { annotationId: event.annotationId });
    } catch (error) {
      client.emit('mark:delete-failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }));

  // AI assist. The assist() Observable encapsulates the full job
  // lifecycle — it subscribes to job:report-progress/complete/fail
  // filtered by its own jobId, emits JobProgress on `next`, completes
  // on `job:complete`, errors on `job:fail`. mark-vm's only job is to
  // drive the three UI observables from that stream.
  subs.push(client.stream('mark:assist-request').subscribe((event) => {
    clearProgressTimer();
    assistingMotivation$.next(event.motivation);
    progress$.next(null);

    const assistSub = client.mark.assist(resourceId, event.motivation, event.options).pipe(
      timeout({ each: 180_000 }),
    ).subscribe({
      next: (p) => progress$.next(p),
      complete: () => {
        assistingMotivation$.next(null);
        clearProgressTimer();
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

  subs.push(client.stream('mark:progress-dismiss').subscribe(() => {
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
