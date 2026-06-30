import { describe, it, expect, vi, afterEach } from 'vitest';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { annotationId, resourceId as makeResourceId } from '@semiont/core';
import type { ShellStateUnit } from '../../../../state/shell-state-unit';
import { createResourceViewerPageStateUnit } from '../resource-viewer-page-state-unit';
import { assertStateUnitAxioms, disposeProbe } from '@semiont/core/testing';
import { makeTestClient, type TestClient } from '../../../../__tests__/test-client';

const RID = makeResourceId('res-1');

function mockBrowse(): ShellStateUnit {
  return {
    activePanel$: new BehaviorSubject(null).asObservable(),
    scrollToAnnotationId$: new BehaviorSubject(null).asObservable(),
    panelInitialTab$: new BehaviorSubject(null).asObservable(),
    onScrollCompleted: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ShellStateUnit;
}

function clientWithNamespaces(overrides: {
  annotations$?: BehaviorSubject<unknown[] | undefined>;
  entityTypes$?: BehaviorSubject<string[] | undefined>;
  events$?: BehaviorSubject<unknown[] | undefined>;
  referencedBy$?: BehaviorSubject<unknown[] | undefined>;
  resourceRepresentation?: ReturnType<typeof vi.fn>;
  mediaToken?: ReturnType<typeof vi.fn>;
} = {}): TestClient {
  const annotations$ = overrides.annotations$ ?? new BehaviorSubject<unknown[] | undefined>([]);
  const entityTypes$ = overrides.entityTypes$ ?? new BehaviorSubject<string[] | undefined>(['Person']);
  const events$ = overrides.events$ ?? new BehaviorSubject<unknown[] | undefined>([]);
  const referencedBy$ = overrides.referencedBy$ ?? new BehaviorSubject<unknown[] | undefined>([]);

  return makeTestClient({
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
  });
}

describe('createResourceViewerPageStateUnit', () => {
  let tc: TestClient;

  afterEach(() => { tc?.bus.destroy(); });

  it('exposes flow VMs', () => {
    tc = clientWithNamespaces();
    const stateUnit = createResourceViewerPageStateUnit(tc.client, RID, 'en', mockBrowse());

    expect(stateUnit.beckon).toBeDefined();
    expect(stateUnit.mark).toBeDefined();
    expect(stateUnit.gather).toBeDefined();
    expect(stateUnit.yield).toBeDefined();
    expect(stateUnit.browse).toBeDefined();

    stateUnit.dispose();
  });

  it('derives annotations from browse namespace', async () => {
    const annotations$ = new BehaviorSubject<unknown[] | undefined>([
      { id: 'a1', motivation: 'highlighting' },
    ]);
    tc = clientWithNamespaces({ annotations$ });
    const stateUnit = createResourceViewerPageStateUnit(tc.client, RID, 'en', mockBrowse());

    const anns = await firstValueFrom(stateUnit.annotations$);
    expect(anns).toHaveLength(1);

    stateUnit.dispose();
  });

  it('groups annotations by type', async () => {
    const annotations$ = new BehaviorSubject<unknown[] | undefined>([
      { id: 'a1', motivation: 'highlighting', target: { selector: { type: 'TextQuoteSelector', exact: 'x' } } },
      { id: 'a2', motivation: 'commenting', body: [{ type: 'TextualBody', value: 'note' }], target: { selector: { type: 'TextQuoteSelector', exact: 'y' } } },
    ]);
    tc = clientWithNamespaces({ annotations$ });
    const stateUnit = createResourceViewerPageStateUnit(tc.client, RID, 'en', mockBrowse());

    const groups = await firstValueFrom(stateUnit.annotationGroups$);
    expect(groups.highlights.length + groups.comments.length).toBeGreaterThanOrEqual(1);

    stateUnit.dispose();
  });

  it('exposes entity types', async () => {
    tc = clientWithNamespaces();
    const stateUnit = createResourceViewerPageStateUnit(tc.client, RID, 'en', mockBrowse());

    const types = await firstValueFrom(stateUnit.entityTypes$);
    expect(types).toEqual(['Person']);

    stateUnit.dispose();
  });

  it('exposes events from browse namespace', async () => {
    const events$ = new BehaviorSubject<unknown[] | undefined>([{ id: 'e1', type: 'mark:added' }]);
    tc = clientWithNamespaces({ events$ });
    const stateUnit = createResourceViewerPageStateUnit(tc.client, RID, 'en', mockBrowse());

    const events = await firstValueFrom(stateUnit.events$);
    expect(events).toEqual([{ id: 'e1', type: 'mark:added' }]);

    stateUnit.dispose();
  });

  it('exposes referencedBy from browse namespace', async () => {
    const referencedBy$ = new BehaviorSubject<unknown[] | undefined>([{ resourceId: 'r2' }]);
    tc = clientWithNamespaces({ referencedBy$ });
    const stateUnit = createResourceViewerPageStateUnit(tc.client, RID, 'en', mockBrowse());

    const refs = await firstValueFrom(stateUnit.referencedBy$);
    expect(refs).toEqual([{ resourceId: 'r2' }]);

    stateUnit.dispose();
  });

  it('fetches media token for binary types', async () => {
    const mediaToken = vi.fn().mockResolvedValue({ token: 'tok-456' });
    tc = clientWithNamespaces({ mediaToken });
    const stateUnit = createResourceViewerPageStateUnit(
      tc.client, RID, 'en', mockBrowse(),
      { mediaType: 'image/png' },
    );

    const token = await firstValueFrom(stateUnit.mediaToken$.pipe(filter((t) => t !== null)));
    expect(token).toBe('tok-456');

    stateUnit.dispose();
  });

  // isBinaryType keys off textExtractionOf(...) !== 'decode', not render mode:
  // storage-tier binary (ZIP, gif/webp) must be fetched as bytes, never
  // decoded as text — the client-side twin of the Phase 3a serving-side fix.
  it('fetches storage-tier binary (ZIP) as bytes, never the text-decode path', async () => {
    const mediaToken = vi.fn().mockResolvedValue({ token: 'tok-zip' });
    const resourceRepresentation = vi.fn();
    tc = clientWithNamespaces({ mediaToken, resourceRepresentation });
    const stateUnit = createResourceViewerPageStateUnit(
      tc.client, RID, 'en', mockBrowse(),
      { mediaType: 'application/zip' },
    );

    const token = await firstValueFrom(stateUnit.mediaToken$.pipe(filter((t) => t !== null)));
    expect(token).toBe('tok-zip');
    expect(resourceRepresentation).not.toHaveBeenCalled();

    stateUnit.dispose();
  });

  it('decodes a registry-miss text/* subtype via the text path (RFC 2046)', async () => {
    const mediaToken = vi.fn();
    const resourceRepresentation = vi.fn().mockResolvedValue({
      data: new TextEncoder().encode('hi').buffer,
      contentType: 'text/x-custom',
    });
    tc = clientWithNamespaces({ mediaToken, resourceRepresentation });
    const stateUnit = createResourceViewerPageStateUnit(
      tc.client, RID, 'en', mockBrowse(),
      { mediaType: 'text/x-custom' },
    );

    expect(resourceRepresentation).toHaveBeenCalled();
    expect(mediaToken).not.toHaveBeenCalled();

    stateUnit.dispose();
  });

  it('wizard initializes closed', async () => {
    tc = clientWithNamespaces();
    const stateUnit = createResourceViewerPageStateUnit(tc.client, RID, 'en', mockBrowse());

    const wizard = await firstValueFrom(stateUnit.wizard$);
    expect(wizard.open).toBe(false);

    stateUnit.dispose();
  });

  it('bind:initiate opens wizard and fires gather:requested', async () => {
    tc = clientWithNamespaces();
    const stateUnit = createResourceViewerPageStateUnit(tc.client, RID, 'en', mockBrowse());
    const gatherEvents: unknown[] = [];
    tc.bus.get('gather:requested').subscribe((e) => gatherEvents.push(e));

    tc.bus.get('bind:initiate').next({
      annotationId: annotationId('ann-1'),
      resourceId: makeResourceId('res-1'),
      defaultTitle: 'Test',
      entityTypes: ['Person'],
    });

    const wizard = await firstValueFrom(stateUnit.wizard$.pipe(filter((w) => w.open)));
    expect(wizard.annotationId).toBe('ann-1');
    expect(gatherEvents).toHaveLength(1);

    stateUnit.dispose();
  });

  it('closeWizard resets wizard state', async () => {
    tc = clientWithNamespaces();
    const stateUnit = createResourceViewerPageStateUnit(tc.client, RID, 'en', mockBrowse());

    tc.bus.get('bind:initiate').next({
      annotationId: annotationId('ann-1'),
      resourceId: makeResourceId('res-1'),
      defaultTitle: 'Test',
      entityTypes: [],
    });

    await firstValueFrom(stateUnit.wizard$.pipe(filter((w) => w.open)));
    stateUnit.closeWizard();

    const wizard = await firstValueFrom(stateUnit.wizard$.pipe(filter((w) => !w.open)));
    expect(wizard.open).toBe(false);

    stateUnit.dispose();
  });
});

describe('ResourceViewerPageStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms (A7-passed: browse survives; A7-owned: children disposed)', () => {
    const RID = makeResourceId('res-ax');
    assertStateUnitAxioms({
      setup: () => {
        const browse = disposeProbe();
        const tc = clientWithNamespaces();
        return {
          unit: createResourceViewerPageStateUnit(tc.client, RID, 'en', browse as unknown as ShellStateUnit),
          passedIn: [browse],
          teardown: () => tc.bus.destroy(),
        };
      },
      surfaces: (u) => [u.wizard$, u.content$, u.contentLoading$, u.mediaToken$],
      invocations: (u) => [() => u.closeWizard()],
      // A7-owned: the internally-constructed children must be disposed when the page
      // disposes — proven by their own surfaces completing. (Match has no public
      // surface; it's disposed via the same disposer.)
      ownedChildSurfaces: (u) => [
        u.beckon.hoveredAnnotationId$,
        u.mark.pendingAnnotation$,
        u.gather.context$,
        u.yield.isGenerating$,
      ],
      numRuns: 5,
    });
  });
});
