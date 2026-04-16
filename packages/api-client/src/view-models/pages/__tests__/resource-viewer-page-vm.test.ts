import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { SemiontApiClient } from '../../../client';
import type { BrowseVM } from '../../flows/browse-vm';
import { createResourceViewerPageVM } from '../resource-viewer-page-vm';

const RID = makeResourceId('res-1');

function mockBrowse(): BrowseVM {
  return {
    activePanel$: new BehaviorSubject(null).asObservable(),
    scrollToAnnotationId$: new BehaviorSubject(null).asObservable(),
    panelInitialTab$: new BehaviorSubject(null).asObservable(),
    onScrollCompleted: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    dispose: vi.fn(),
  } as unknown as BrowseVM;
}

function mockClient(overrides: {
  annotations$?: BehaviorSubject<unknown[] | undefined>;
  entityTypes$?: BehaviorSubject<string[] | undefined>;
  events$?: BehaviorSubject<unknown[] | undefined>;
  referencedBy$?: BehaviorSubject<unknown[] | undefined>;
  resourceRepresentation?: ReturnType<typeof vi.fn>;
  mediaToken?: ReturnType<typeof vi.fn>;
} = {}): SemiontApiClient {
  const annotations$ = overrides.annotations$ ?? new BehaviorSubject<unknown[] | undefined>([]);
  const entityTypes$ = overrides.entityTypes$ ?? new BehaviorSubject<string[] | undefined>(['Person']);
  const events$ = overrides.events$ ?? new BehaviorSubject<unknown[] | undefined>([]);
  const referencedBy$ = overrides.referencedBy$ ?? new BehaviorSubject<unknown[] | undefined>([]);

  return {
    browse: {
      annotations: () => annotations$.asObservable(),
      entityTypes: () => entityTypes$.asObservable(),
      events: () => events$.asObservable(),
      referencedBy: () => referencedBy$.asObservable(),
      resourceRepresentation: overrides.resourceRepresentation ?? vi.fn().mockResolvedValue({
        data: new TextEncoder().encode('hello').buffer,
        contentType: 'text/plain',
      }),
    },
    auth: {
      mediaToken: overrides.mediaToken ?? vi.fn().mockResolvedValue({ token: 'tok-123' }),
    },
    mark: {
      annotation: vi.fn().mockResolvedValue({ annotationId: 'ann-new' }),
      delete: vi.fn().mockResolvedValue(undefined),
      assist: vi.fn(() => new Observable(() => {})),
    },
    gather: { annotation: vi.fn(() => new Observable(() => {})) },
    match: { search: vi.fn(() => new Observable(() => {})) },
    yield: { fromAnnotation: vi.fn(() => new Observable(() => {})) },
    bind: { body: vi.fn().mockResolvedValue(undefined) },
    eventBus: new EventBus(),
  } as unknown as SemiontApiClient;
}

describe('createResourceViewerPageVM', () => {
  let eventBus: EventBus;

  beforeEach(() => { eventBus = new EventBus(); });
  afterEach(() => { eventBus.destroy(); });

  it('exposes flow VMs', () => {
    const vm = createResourceViewerPageVM(mockClient(), eventBus, RID, 'en', mockBrowse());

    expect(vm.beckon).toBeDefined();
    expect(vm.mark).toBeDefined();
    expect(vm.gather).toBeDefined();
    expect(vm.yield).toBeDefined();
    expect(vm.browse).toBeDefined();

    vm.dispose();
  });

  it('derives annotations from browse namespace', async () => {
    const annotations$ = new BehaviorSubject<unknown[] | undefined>([
      { id: 'a1', motivation: 'highlighting' },
    ]);
    const vm = createResourceViewerPageVM(mockClient({ annotations$ }), eventBus, RID, 'en', mockBrowse());

    const anns = await firstValueFrom(vm.annotations$);
    expect(anns).toHaveLength(1);

    vm.dispose();
  });

  it('groups annotations by type', async () => {
    const annotations$ = new BehaviorSubject<unknown[] | undefined>([
      { id: 'a1', motivation: 'highlighting', target: { selector: { type: 'TextQuoteSelector', exact: 'x' } } },
      { id: 'a2', motivation: 'commenting', body: [{ type: 'TextualBody', value: 'note' }], target: { selector: { type: 'TextQuoteSelector', exact: 'y' } } },
    ]);
    const vm = createResourceViewerPageVM(mockClient({ annotations$ }), eventBus, RID, 'en', mockBrowse());

    const groups = await firstValueFrom(vm.annotationGroups$);
    expect(groups.highlights.length + groups.comments.length).toBeGreaterThanOrEqual(1);

    vm.dispose();
  });

  it('exposes entity types', async () => {
    const vm = createResourceViewerPageVM(mockClient(), eventBus, RID, 'en', mockBrowse());

    const types = await firstValueFrom(vm.entityTypes$);
    expect(types).toEqual(['Person']);

    vm.dispose();
  });

  it('exposes events from browse namespace', async () => {
    const events$ = new BehaviorSubject<unknown[] | undefined>([{ id: 'e1', type: 'mark:added' }]);
    const vm = createResourceViewerPageVM(mockClient({ events$ }), eventBus, RID, 'en', mockBrowse());

    const events = await firstValueFrom(vm.events$);
    expect(events).toEqual([{ id: 'e1', type: 'mark:added' }]);

    vm.dispose();
  });

  it('exposes referencedBy from browse namespace', async () => {
    const referencedBy$ = new BehaviorSubject<unknown[] | undefined>([{ resourceId: 'r2' }]);
    const vm = createResourceViewerPageVM(mockClient({ referencedBy$ }), eventBus, RID, 'en', mockBrowse());

    const refs = await firstValueFrom(vm.referencedBy$);
    expect(refs).toEqual([{ resourceId: 'r2' }]);

    vm.dispose();
  });

  it('fetches media token for binary types', async () => {
    const mediaToken = vi.fn().mockResolvedValue({ token: 'tok-456' });
    const vm = createResourceViewerPageVM(
      mockClient({ mediaToken }),
      eventBus, RID, 'en', mockBrowse(),
      { mediaType: 'image/png' },
    );

    const token = await firstValueFrom(vm.mediaToken$.pipe(filter((t) => t !== null)));
    expect(token).toBe('tok-456');

    vm.dispose();
  });

  it('wizard initializes closed', async () => {
    const vm = createResourceViewerPageVM(mockClient(), eventBus, RID, 'en', mockBrowse());

    const wizard = await firstValueFrom(vm.wizard$);
    expect(wizard.open).toBe(false);

    vm.dispose();
  });

  it('bind:initiate opens wizard and fires gather:requested', async () => {
    const vm = createResourceViewerPageVM(mockClient(), eventBus, RID, 'en', mockBrowse());
    const gatherEvents: unknown[] = [];
    eventBus.get('gather:requested').subscribe((e) => gatherEvents.push(e));

    eventBus.get('bind:initiate').next({
      annotationId: 'ann-1',
      resourceId: 'res-1',
      defaultTitle: 'Test',
      entityTypes: ['Person'],
    });

    const wizard = await firstValueFrom(vm.wizard$.pipe(filter((w) => w.open)));
    expect(wizard.annotationId).toBe('ann-1');
    expect(gatherEvents).toHaveLength(1);

    vm.dispose();
  });

  it('closeWizard resets wizard state', async () => {
    const vm = createResourceViewerPageVM(mockClient(), eventBus, RID, 'en', mockBrowse());

    eventBus.get('bind:initiate').next({
      annotationId: 'ann-1',
      resourceId: 'res-1',
      defaultTitle: 'Test',
      entityTypes: [],
    });

    await firstValueFrom(vm.wizard$.pipe(filter((w) => w.open)));
    vm.closeWizard();

    const wizard = await firstValueFrom(vm.wizard$.pipe(filter((w) => !w.open)));
    expect(wizard.open).toBe(false);

    vm.dispose();
  });
});
