import { BehaviorSubject, type Observable, type Subscription, map } from 'rxjs';
import type { ResourceId, components } from '@semiont/core';
import { createDisposer } from '@semiont/sdk';
import type { StateUnit } from '@semiont/core';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import { createBeckonStateUnit, type BeckonStateUnit } from '@semiont/sdk';
import { createMarkStateUnit, type MarkStateUnit } from '@semiont/sdk';
import { createGatherStateUnit, type GatherStateUnit } from '@semiont/sdk';
import { createMatchStateUnit } from '@semiont/sdk';
import { createYieldStateUnit, type YieldStateUnit } from '@semiont/sdk';
import type { SemiontClient } from '@semiont/sdk';
import { decodeWithCharset, textExtractionOf } from '@semiont/core';
import { groupAnnotations } from '../../../lib/annotation-groups';
import type { ReferencedByEntry } from '@semiont/sdk';

import type { Annotation } from '@semiont/core';

export interface AnnotationGroups {
  highlights: Annotation[];
  comments: Annotation[];
  assessments: Annotation[];
  references: Annotation[];
  tags: Annotation[];
}
type StoredEventResponse = components['schemas']['StoredEventResponse'];

export interface WizardState {
  open: boolean;
  annotationId: string | null;
  resourceId: string | null;
  defaultTitle: string;
  entityTypes: string[];
}

const WIZARD_CLOSED: WizardState = {
  open: false, annotationId: null, resourceId: null, defaultTitle: '', entityTypes: [],
};

/**
 * A cache-backed list in its three real states.
 *
 * `loading` is NOT "the value is undefined": `browse.*()` delivers a terminal
 * failure as an RxJS error (B15) once B14's retry is exhausted with nothing
 * stored, and a key that failed has no value either — so a two-state model
 * reports a dead request as an eternal spinner and drops the reason. `value$`
 * still carries an empty list through a failure, so a panel can render its
 * frame either way.
 * See .plans/PANEL-FAILURE-STATES.md
 */
export interface ListState<T> {
  value$: Observable<T>;
  loading$: Observable<boolean>;
  error$: Observable<Error | null>;
  /** Re-subscribe: B15 clears the failure marker on a fresh `observe()`. */
  retry(): void;
}

/**
 * Track one `browse.*()` query as a `ListState`.
 *
 * `open` is a THUNK, not an observable: an errored observable is terminated,
 * and calling `browse.x()` again is what re-enters `observe()` — which is
 * where the cache clears the B15 marker and starts a fresh attempt chain.
 * Same reason `createResourceLoaderStateUnit` re-`attach()`es.
 */
function trackList<T>(open: () => Observable<T | undefined>, empty: T): {
  state: ListState<T>;
  dispose: () => void;
} {
  const value$ = new BehaviorSubject<T>(empty);
  const loading$ = new BehaviorSubject<boolean>(true);
  const error$ = new BehaviorSubject<Error | null>(null);

  let subscription: Subscription | null = null;
  let disposed = false;

  const attach = (): void => {
    if (disposed) return;
    subscription?.unsubscribe();
    subscription = open().subscribe({
      next: (value) => {
        if (error$.getValue() !== null) error$.next(null);
        // The cache emits `undefined` for a key it has not resolved yet; that
        // is the loading state, not a value.
        if (value === undefined) return;
        value$.next(value);
        if (loading$.getValue()) loading$.next(false);
      },
      error: (e: unknown) => {
        error$.next(e instanceof Error ? e : new Error(String(e)));
        if (loading$.getValue()) loading$.next(false);
      },
    });
  };
  attach();

  return {
    state: {
      // X1: owned subjects are published read-only.
      value$: value$.asObservable(),
      loading$: loading$.asObservable(),
      error$: error$.asObservable(),
      retry: () => {
        if (disposed) return;
        error$.next(null);
        loading$.next(true);
        attach();
      },
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      subscription?.unsubscribe();
      subscription = null;
      value$.complete();
      loading$.complete();
      error$.complete();
    },
  };
}

export interface ResourceViewerPageStateUnit extends StateUnit {
  beckon: BeckonStateUnit;
  browse: ShellStateUnit;
  mark: MarkStateUnit;
  gather: GatherStateUnit;
  yield: YieldStateUnit;

  annotations: ListState<Annotation[]>;
  entityTypes: ListState<string[]>;
  events: ListState<StoredEventResponse[]>;
  referencedBy: ListState<ReferencedByEntry[]>;
  /** Derived from `annotations.value$`; failure/loading live on `annotations`. */
  annotationGroups$: Observable<AnnotationGroups>;
  content$: Observable<string>;
  contentLoading$: Observable<boolean>;
  mediaToken$: Observable<string | null>;
  wizard$: Observable<WizardState>;

  closeWizard(): void;
}

export function createResourceViewerPageStateUnit(
  client: SemiontClient,
  resourceId: ResourceId,
  locale: string,
  browse: ShellStateUnit,
  options?: { mediaType?: string },
): ResourceViewerPageStateUnit {
  const disposer = createDisposer();

  const beckon = createBeckonStateUnit(client);
  const mark = createMarkStateUnit(client, resourceId);
  const gather = createGatherStateUnit(client, resourceId);
  const matchStateUnit = createMatchStateUnit(client, resourceId);
  const yieldStateUnit = createYieldStateUnit(client, resourceId, locale);

  disposer.add(beckon);
  // `browse` (ShellStateUnit) is a *passed-in* dependency — owned by `useShellStateUnit`,
  // not this page unit. Do NOT add it to the disposer: it's app-scoped and shared, so
  // disposing it on page teardown would tear down (or double-dispose) the shared shell.
  // See packages/sdk/docs/STATE-UNITS.md (composition: only dispose children you construct).
  disposer.add(mark);
  disposer.add(gather);
  disposer.add(matchStateUnit);
  disposer.add(yieldStateUnit);

  const annotations = trackList<Annotation[]>(() => client.browse.annotations(resourceId), []);
  const entityTypes = trackList<string[]>(() => client.browse.entityTypes(), []);
  const events = trackList<StoredEventResponse[]>(() => client.browse.events(resourceId), []);
  const referencedBy = trackList<ReferencedByEntry[]>(() => client.browse.referencedBy(resourceId), []);
  disposer.add(annotations.dispose);
  disposer.add(entityTypes.dispose);
  disposer.add(events.dispose);
  disposer.add(referencedBy.dispose);

  const annotationGroups$: Observable<AnnotationGroups> =
    annotations.state.value$.pipe(map(groupAnnotations));

  const content$ = new BehaviorSubject<string>('');
  const contentLoading$ = new BehaviorSubject<boolean>(false);
  const mediaToken$ = new BehaviorSubject<string | null>(null);

  const mediaType = options?.mediaType || 'text/plain';
  // "Fetch raw bytes or decode as text?" — binary iff the registry says this
  // type does not decode to text. Storage-tier images (gif/webp) are
  // render:'none' but still binary, and a ZIP must avoid the text path; a
  // mechanical render-mode check would mis-route both into mojibake.
  const isBinaryType = textExtractionOf(mediaType) !== 'decode';

  if (!isBinaryType && mediaType) {
    contentLoading$.next(true);
    client.browse.resourceRepresentation(resourceId)
      .then(({ data, contentType }) => {
        content$.next(decodeWithCharset(data, contentType));
        contentLoading$.next(false);
      })
      .catch(() => { contentLoading$.next(false); });
  }

  if (isBinaryType) {
    client.auth!.mediaToken(resourceId)
      .then(({ token }) => mediaToken$.next(token))
      .catch(() => {});
  }

  const wizard$ = new BehaviorSubject<WizardState>(WIZARD_CLOSED);

  // Resource-scoped freshness follows observation (#847): subscribing to the
  // `browse.*(resourceId)` live queries exposed by this state unit
  // (annotations$, events$, referencedBy$) acquires the resource scope for as
  // long as they're observed and releases it on teardown — so no manual
  // `subscribeToResource` call is needed.

  const bindInitiateSub = client.bus.get('bind:initiate').subscribe((event) => {
    wizard$.next({
      open: true,
      annotationId: event.annotationId,
      resourceId: event.resourceId,
      defaultTitle: event.defaultTitle,
      entityTypes: event.entityTypes,
    });
    client.bus.get('gather:requested').next({
      correlationId: crypto.randomUUID(),
      annotationId: event.annotationId,
      resourceId: event.resourceId,
      options: { contextWindow: 2000 },
    });
  });
  disposer.add(() => bindInitiateSub.unsubscribe());

  return {
    beckon,
    browse,
    mark,
    gather,
    yield: yieldStateUnit,
    annotations: annotations.state,
    entityTypes: entityTypes.state,
    events: events.state,
    referencedBy: referencedBy.state,
    annotationGroups$,
    content$: content$.asObservable(),
    contentLoading$: contentLoading$.asObservable(),
    mediaToken$: mediaToken$.asObservable(),
    wizard$: wizard$.asObservable(),
    closeWizard: () => wizard$.next(WIZARD_CLOSED),
    dispose: () => {
      wizard$.complete();
      content$.complete();
      contentLoading$.complete();
      mediaToken$.complete();
      disposer.dispose();
    },
  };
}
