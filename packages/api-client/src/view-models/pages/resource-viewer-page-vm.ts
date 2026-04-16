import { BehaviorSubject, type Observable, map } from 'rxjs';
import type { EventBus, ResourceId, components } from '@semiont/core';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { BrowseVM } from '../flows/browse-vm';
import { createBeckonVM, type BeckonVM } from '../flows/beckon-vm';
import { createMarkVM, type MarkVM } from '../flows/mark-vm';
import { createGatherVM, type GatherVM } from '../flows/gather-vm';
import { createMatchVM } from '../flows/match-vm';
import { createYieldVM, type YieldVM } from '../flows/yield-vm';
import { createBindVM } from '../flows/bind-vm';
import type { SemiontApiClient } from '../../client';
import { decodeWithCharset } from '../../utils/text-encoding';
import type { ReferencedByEntry } from '../../namespaces/types';

type Annotation = components['schemas']['Annotation'];
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

export interface ResourceViewerPageVM extends ViewModel {
  beckon: BeckonVM;
  browse: BrowseVM;
  mark: MarkVM;
  gather: GatherVM;
  yield: YieldVM;

  annotations$: Observable<Annotation[]>;
  entityTypes$: Observable<string[]>;
  events$: Observable<StoredEventResponse[]>;
  referencedBy$: Observable<ReferencedByEntry[]>;
  content$: Observable<string>;
  contentLoading$: Observable<boolean>;
  mediaToken$: Observable<string | null>;
  wizard$: Observable<WizardState>;

  closeWizard(): void;
}

export function createResourceViewerPageVM(
  client: SemiontApiClient,
  eventBus: EventBus,
  resourceId: ResourceId,
  locale: string,
  browse: BrowseVM,
  options?: { mediaType?: string },
): ResourceViewerPageVM {
  const disposer = createDisposer();

  const beckon = createBeckonVM(eventBus);
  const mark = createMarkVM(client, eventBus, resourceId);
  const gather = createGatherVM(client, eventBus, resourceId);
  const matchVM = createMatchVM(client, eventBus, resourceId);
  const bindVM = createBindVM(client, eventBus, resourceId);
  const yieldVM = createYieldVM(client, eventBus, resourceId, locale);

  disposer.add(beckon);
  disposer.add(browse);
  disposer.add(mark);
  disposer.add(gather);
  disposer.add(matchVM);
  disposer.add(bindVM);
  disposer.add(yieldVM);

  const annotations$: Observable<Annotation[]> = client.browse.annotations(resourceId).pipe(
    map((a) => a ?? []),
  );

  const entityTypes$: Observable<string[]> = client.browse.entityTypes().pipe(
    map((e) => e ?? []),
  );

  const events$: Observable<StoredEventResponse[]> = client.browse.events(resourceId).pipe(
    map((e) => e ?? []),
  );

  const referencedBy$: Observable<ReferencedByEntry[]> = client.browse.referencedBy(resourceId).pipe(
    map((r) => r ?? []),
  );

  const content$ = new BehaviorSubject<string>('');
  const contentLoading$ = new BehaviorSubject<boolean>(false);
  const mediaToken$ = new BehaviorSubject<string | null>(null);

  const mediaType = options?.mediaType || 'text/plain';
  const isBinaryType = mediaType.startsWith('image/') || mediaType === 'application/pdf';

  if (!isBinaryType && mediaType) {
    contentLoading$.next(true);
    client.browse.resourceRepresentation(resourceId, { accept: mediaType })
      .then(({ data }) => {
        content$.next(decodeWithCharset(data, mediaType));
        contentLoading$.next(false);
      })
      .catch(() => { contentLoading$.next(false); });
  }

  if (isBinaryType) {
    client.auth.mediaToken(resourceId)
      .then(({ token }) => mediaToken$.next(token))
      .catch(() => {});
  }

  const wizard$ = new BehaviorSubject<WizardState>(WIZARD_CLOSED);

  const bindInitiateSub = eventBus.get('bind:initiate').subscribe((event) => {
    wizard$.next({
      open: true,
      annotationId: event.annotationId,
      resourceId: event.resourceId,
      defaultTitle: event.defaultTitle,
      entityTypes: event.entityTypes,
    });
    eventBus.get('gather:requested').next({
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
    yield: yieldVM,
    annotations$,
    entityTypes$,
    events$,
    referencedBy$,
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
