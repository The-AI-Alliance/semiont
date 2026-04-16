import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import type { EventBus, ResourceId, Motivation, Selector, MarkProgress, EventMap } from '@semiont/core';
import type { SemiontApiClient } from '../../client';
import type { ViewModel } from '../lib/view-model';

export interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface MarkVM extends ViewModel {
  pendingAnnotation$: Observable<PendingAnnotation | null>;
  assistingMotivation$: Observable<Motivation | null>;
  progress$: Observable<MarkProgress | null>;
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
  eventBus: EventBus,
  resourceId: ResourceId,
): MarkVM {
  const subs: Subscription[] = [];
  const pendingAnnotation$ = new BehaviorSubject<PendingAnnotation | null>(null);
  const assistingMotivation$ = new BehaviorSubject<Motivation | null>(null);
  const progress$ = new BehaviorSubject<MarkProgress | null>(null);
  let progressDismissTimer: ReturnType<typeof setTimeout> | null = null;

  const clearProgressTimer = () => {
    if (progressDismissTimer) { clearTimeout(progressDismissTimer); progressDismissTimer = null; }
  };

  const handleAnnotationRequested = (pending: PendingAnnotation) => {
    eventBus.get('browse:panel-open').next({ panel: 'annotations' });
    pendingAnnotation$.next(pending);
  };

  // Selection events → pending annotation
  subs.push(eventBus.get('mark:requested').subscribe(handleAnnotationRequested));
  subs.push(eventBus.get('mark:select-comment').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'commenting' })));
  subs.push(eventBus.get('mark:select-tag').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'tagging' })));
  subs.push(eventBus.get('mark:select-assessment').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'assessing' })));
  subs.push(eventBus.get('mark:select-reference').subscribe((s) =>
    handleAnnotationRequested({ selector: selectionToSelector(s), motivation: 'linking' })));

  subs.push(eventBus.get('mark:cancel-pending').subscribe(() => pendingAnnotation$.next(null)));
  subs.push(eventBus.get('mark:create-ok').subscribe(() => pendingAnnotation$.next(null)));

  // CRUD bridging
  subs.push(eventBus.get('mark:submit').subscribe(async (event) => {
    try {
      const result = await client.mark.annotation(resourceId, {
        motivation: event.motivation,
        target: { source: resourceId, selector: event.selector as Selector },
        body: event.body,
      });
      eventBus.get('mark:create-ok').next({ annotationId: result.annotationId });
    } catch (error) {
      eventBus.get('mark:create-failed').next({ message: error instanceof Error ? error.message : String(error) });
    }
  }));

  subs.push(eventBus.get('mark:delete').subscribe(async (event) => {
    try {
      await client.mark.delete(resourceId, event.annotationId as Parameters<typeof client.mark.delete>[1]);
      eventBus.get('mark:delete-ok').next({ annotationId: event.annotationId });
    } catch (error) {
      eventBus.get('mark:delete-failed').next({ message: error instanceof Error ? error.message : String(error) });
    }
  }));

  // AI assist
  subs.push(eventBus.get('mark:assist-request').subscribe((event) => {
    clearProgressTimer();
    assistingMotivation$.next(event.motivation);
    progress$.next(null);

    const assistSub = client.mark.assist(resourceId, event.motivation, event.options).pipe(
      timeout({ each: 180_000 }),
    ).subscribe({
      next: (p) => progress$.next(p as MarkProgress),
      error: (err) => eventBus.get('mark:assist-failed').next({
        resourceId: resourceId as string,
        message: err instanceof Error ? err.message : String(err),
      }),
    });
    subs.push(assistSub);
  }));

  subs.push(eventBus.get('mark:progress').subscribe((chunk: MarkProgress) => progress$.next(chunk)));

  subs.push(eventBus.get('mark:assist-finished').subscribe((event) => {
    const current = assistingMotivation$.getValue();
    if (event.motivation && event.motivation === current) {
      assistingMotivation$.next(null);
    }
    // Keep progress visible for 5 seconds after completion
    clearProgressTimer();
    progressDismissTimer = setTimeout(() => { progress$.next(null); progressDismissTimer = null; }, 5000);
  }));

  subs.push(eventBus.get('mark:assist-failed').subscribe(() => {
    clearProgressTimer();
    assistingMotivation$.next(null);
    progress$.next(null);
  }));

  subs.push(eventBus.get('mark:progress-dismiss').subscribe(() => {
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
