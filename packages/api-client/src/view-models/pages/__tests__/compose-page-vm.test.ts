import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontApiClient } from '../../../client';
import type { BrowseVM } from '../../flows/browse-vm';
import { createComposePageVM } from '../compose-page-vm';

function mockBrowse(): BrowseVM {
  return { dispose: vi.fn() } as unknown as BrowseVM;
}

function mockClient(overrides: {
  entityTypes$?: BehaviorSubject<string[] | undefined>;
  fromToken?: ReturnType<typeof vi.fn>;
  getResourceRepresentation?: ReturnType<typeof vi.fn>;
  createFromToken?: ReturnType<typeof vi.fn>;
  resource?: ReturnType<typeof vi.fn>;
  body?: ReturnType<typeof vi.fn>;
} = {}): SemiontApiClient {
  const entityTypes$ = overrides.entityTypes$ ?? new BehaviorSubject<string[] | undefined>(['Person']);
  return {
    browse: {
      entityTypes: () => entityTypes$.asObservable(),
    },
    yield: {
      fromToken: overrides.fromToken ?? vi.fn().mockResolvedValue({ '@id': 'src-1', representations: [{ mediaType: 'text/plain' }] }),
      createFromToken: overrides.createFromToken ?? vi.fn().mockResolvedValue({ resourceId: 'new-1' }),
      resource: overrides.resource ?? vi.fn().mockResolvedValue({ resourceId: 'new-2' }),
    },
    bind: {
      body: overrides.body ?? vi.fn().mockResolvedValue(undefined),
    },
    getResourceRepresentation: overrides.getResourceRepresentation ?? vi.fn().mockResolvedValue({
      data: new TextEncoder().encode('source content').buffer,
      contentType: 'text/plain',
    }),
  } as unknown as SemiontApiClient;
}

describe('createComposePageVM', () => {
  it('defaults to "new" mode', async () => {
    const vm = createComposePageVM(mockClient(), mockBrowse(), {});

    const mode = await firstValueFrom(vm.mode$);
    expect(mode).toBe('new');

    const loading = await firstValueFrom(vm.loading$.pipe(filter((l) => !l)));
    expect(loading).toBe(false);

    vm.dispose();
  });

  it('detects reference mode from params', async () => {
    const vm = createComposePageVM(mockClient(), mockBrowse(), {
      annotationUri: 'ann-1',
      sourceDocumentId: 'doc-1',
      name: 'Reference Doc',
      entityTypes: 'Person,Place',
    });

    const mode = await firstValueFrom(vm.mode$);
    expect(mode).toBe('reference');

    const ref = await firstValueFrom(vm.referenceData$.pipe(filter((r) => r !== null)));
    expect(ref!.annotationUri).toBe('ann-1');
    expect(ref!.entityTypes).toEqual(['Person', 'Place']);

    vm.dispose();
  });

  it('parses storedContext in reference mode', async () => {
    const context = { annotation: { id: 'ann-1' }, sourceContext: 'text' };
    const vm = createComposePageVM(mockClient(), mockBrowse(), {
      annotationUri: 'ann-1',
      sourceDocumentId: 'doc-1',
      name: 'Ref',
      storedContext: JSON.stringify(context),
    });

    const gathered = await firstValueFrom(vm.gatheredContext$.pipe(filter((g) => g !== null)));
    expect(gathered).toEqual(context);

    vm.dispose();
  });

  it('ignores malformed storedContext', async () => {
    const vm = createComposePageVM(mockClient(), mockBrowse(), {
      annotationUri: 'ann-1',
      sourceDocumentId: 'doc-1',
      name: 'Ref',
      storedContext: 'not-json{{{',
    });

    const loading = await firstValueFrom(vm.loading$.pipe(filter((l) => !l)));
    expect(loading).toBe(false);

    const gathered = await firstValueFrom(vm.gatheredContext$);
    expect(gathered).toBeNull();

    vm.dispose();
  });

  it('exposes entity types', async () => {
    const vm = createComposePageVM(mockClient(), mockBrowse(), {});

    const types = await firstValueFrom(vm.entityTypes$);
    expect(types).toEqual(['Person']);

    vm.dispose();
  });

  it('save in new mode calls yield.resource', async () => {
    const resource = vi.fn().mockResolvedValue({ resourceId: 'new-3' });
    const vm = createComposePageVM(mockClient({ resource }), mockBrowse(), {});

    const id = await vm.save({
      mode: 'new',
      name: 'Test',
      storageUri: '/docs/test.md',
      content: '# Hello',
      format: 'text/markdown',
      language: 'en',
    });

    expect(id).toBe('new-3');
    expect(resource).toHaveBeenCalledOnce();

    vm.dispose();
  });

  it('save in reference mode calls yield.resource then bind.body', async () => {
    const resource = vi.fn().mockResolvedValue({ resourceId: 'new-4' });
    const body = vi.fn().mockResolvedValue(undefined);
    const vm = createComposePageVM(mockClient({ resource, body }), mockBrowse(), {
      annotationUri: 'ann-1',
      sourceDocumentId: 'doc-1',
      name: 'Ref',
    });

    const id = await vm.save({
      mode: 'reference',
      name: 'Ref Doc',
      storageUri: '/docs/ref.md',
      content: 'content',
      language: 'en',
      annotationUri: 'ann-1',
      sourceDocumentId: 'doc-1',
    });

    expect(id).toBe('new-4');
    expect(body).toHaveBeenCalledOnce();

    vm.dispose();
  });

  it('save in clone mode calls yield.createFromToken', async () => {
    const createFromToken = vi.fn().mockResolvedValue({ resourceId: 'cloned-1' });
    const vm = createComposePageVM(mockClient({ createFromToken }), mockBrowse(), {
      mode: 'clone',
      token: 'tok-abc',
    });

    const id = await vm.save({
      mode: 'clone',
      name: 'Cloned',
      storageUri: '/docs/cloned.md',
      content: 'cloned content',
      language: 'en',
    });

    expect(id).toBe('cloned-1');
    expect(createFromToken).toHaveBeenCalledOnce();

    vm.dispose();
  });
});
