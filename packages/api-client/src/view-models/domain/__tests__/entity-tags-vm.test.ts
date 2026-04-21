import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontApiClient } from '../../../client';
import type { ShellVM } from '../../flows/shell-vm';
import { createEntityTagsVM } from '../entity-tags-vm';

function mockBrowse(): ShellVM {
  return { dispose: vi.fn() } as unknown as ShellVM;
}

function mockClient(overrides: {
  entityTypes$?: BehaviorSubject<string[] | undefined>;
  entityType?: ReturnType<typeof vi.fn>;
} = {}): SemiontApiClient {
  const entityTypes$ = overrides.entityTypes$ ?? new BehaviorSubject<string[] | undefined>(['Person', 'Place']);
  return {
    browse: {
      entityTypes: () => entityTypes$.asObservable(),
    },
    mark: {
      entityType: overrides.entityType ?? vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as SemiontApiClient;
}

describe('createEntityTagsVM', () => {
  it('exposes entity types from browse namespace', async () => {
    const vm = createEntityTagsVM(mockClient(), mockBrowse());

    const types = await firstValueFrom(vm.entityTypes$);
    expect(types).toEqual(['Person', 'Place']);

    vm.dispose();
  });

  it('reports loading when entity types are undefined', async () => {
    const entityTypes$ = new BehaviorSubject<string[] | undefined>(undefined);
    const vm = createEntityTagsVM(mockClient({ entityTypes$ }), mockBrowse());

    const loading = await firstValueFrom(vm.isLoading$);
    expect(loading).toBe(true);

    entityTypes$.next(['Tag']);
    const loaded = await firstValueFrom(vm.isLoading$.pipe(filter((l) => !l)));
    expect(loaded).toBe(false);

    vm.dispose();
  });

  it('setNewTag updates newTag$', async () => {
    const vm = createEntityTagsVM(mockClient(), mockBrowse());

    vm.setNewTag('Organization');
    const tag = await firstValueFrom(vm.newTag$);
    expect(tag).toBe('Organization');

    vm.dispose();
  });

  it('addTag calls client and clears newTag$', async () => {
    const entityType = vi.fn().mockResolvedValue(undefined);
    const vm = createEntityTagsVM(mockClient({ entityType }), mockBrowse());

    vm.setNewTag('Event');
    await vm.addTag();

    expect(entityType).toHaveBeenCalledWith('Event');
    const tag = await firstValueFrom(vm.newTag$);
    expect(tag).toBe('');

    vm.dispose();
  });

  it('addTag ignores empty/whitespace input', async () => {
    const entityType = vi.fn();
    const vm = createEntityTagsVM(mockClient({ entityType }), mockBrowse());

    vm.setNewTag('   ');
    await vm.addTag();

    expect(entityType).not.toHaveBeenCalled();

    vm.dispose();
  });

  it('addTag sets error on failure', async () => {
    const entityType = vi.fn().mockRejectedValue(new Error('duplicate'));
    const vm = createEntityTagsVM(mockClient({ entityType }), mockBrowse());

    vm.setNewTag('Person');
    await vm.addTag();

    const error = await firstValueFrom(vm.error$);
    expect(error).toBe('duplicate');

    const adding = await firstValueFrom(vm.isAdding$);
    expect(adding).toBe(false);

    vm.dispose();
  });
});
