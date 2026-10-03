import type { AnnotationId } from '@semiont/core';
import { BehaviorSubject, type Observable, map } from 'rxjs';
import type { ResourceId, components } from '@semiont/core';
import { createDisposer } from '@semiont/sdk';
import type { StateUnit } from '@semiont/core';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import { trackList, type ListState } from '../../../state/list-state';
import { createBeckonStateUnit, type BeckonStateUnit } from '@semiont/sdk';
import { createMarkStateUnit, type MarkStateUnit } from '@semiont/sdk';
import { createGatherStateUnit, type GatherStateUnit } from '@semiont/sdk';
import { createMatchStateUnit } from '@semiont/sdk';
import { createYieldStateUnit, type YieldStateUnit } from '@semiont/sdk';
import type { SemiontSession } from '@semiont/sdk';
import { uuidV4 } from '@semiont/core';
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
  annotationId: AnnotationId | null;
  resourceId: ResourceId | null;
  defaultTitle: string;
  entityTypes: string[];
}

const WIZARD_CLOSED: WizardState = {
  open: false, annotationId: null, resourceId: null, defaultTitle: '', entityTypes: [],
};

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
  wizard$: Observable<WizardState>;

  closeWizard(): void;
}

// Session-typed (SESSION-TYPED-FACTORIES.md D1): the parameter is the
// lifetime this unit must not outlive. The internal flow units below keep
// the narrower client — their lifetime is THIS unit's disposer, which is now
// session-bound; that is layering, not a loophole.
export function createResourceViewerPageStateUnit(
  session: SemiontSession,
  resourceId: ResourceId,
  locale: string,
  browse: ShellStateUnit,
): ResourceViewerPageStateUnit {
  const { client } = session;
  const disposer = createDisposer();

  const beckon = createBeckonStateUnit(client);
  const mark = createMarkStateUnit(client, resourceId);
  const gather = createGatherStateUnit(client, resourceId);
  const matchStateUnit = createMatchStateUnit(client);
  const yieldStateUnit = createYieldStateUnit(client, locale);

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

  const wizard$ = new BehaviorSubject<WizardState>(WIZARD_CLOSED);

  // Resource-scoped freshness follows observation (#847): subscribing to the
  // `browse.*(resourceId)` live queries exposed by this state unit
  // (annotations$, events$, referencedBy$) acquires the resource scope for as
  // long as they're observed and releases it on teardown — so no manual
  // `subscribeToResource` call is needed.

  const bindInitiateSub = client.bus.on('bind:initiate').subscribe((event) => {
    wizard$.next({
      open: true,
      annotationId: event.annotationId,
      resourceId: event.resourceId,
      defaultTitle: event.defaultTitle,
      entityTypes: event.entityTypes,
    });
    client.bus.emit('gather:requested', {
      annotationId: event.annotationId,
      resourceId: event.resourceId,
      options: { contextWindow: 2000 },
    }, { correlationId: uuidV4() });
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
    wizard$: wizard$.asObservable(),
    closeWizard: () => wizard$.next(WIZARD_CLOSED),
    dispose: () => {
      wizard$.complete();
      disposer.dispose();
    },
  };
}
