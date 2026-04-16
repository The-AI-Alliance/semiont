import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontApiClient } from '../../../client';
import type { BrowseVM } from '../../flows/browse-vm';
import { createDiscoverVM } from '../discover-vm';

function mockBrowse(): BrowseVM {
  return { dispose: vi.fn() } as unknown as BrowseVM;
}

function mockClient(overrides: {
  resources$?: BehaviorSubject<unknown[] | undefined>;
  entityTypes$?: BehaviorSubject<string[] | undefined>;
} = {}): SemiontApiClient {
  const resources$ = overrides.resources$ ?? new BehaviorSubject<unknown[] | undefined>([{ '@id': 'r1' }]);
  const entityTypes$ = overrides.entityTypes$ ?? new BehaviorSubject<string[] | undefined>(['Person']);
  return {
    browse: {
      resources: () => resources$.asObservable(),
      entityTypes: () => entityTypes$.asObservable(),
    },
  } as unknown as SemiontApiClient;
}

describe('createDiscoverVM', () => {
  it('exposes recent resources from browse namespace', async () => {
    const vm = createDiscoverVM(mockClient(), mockBrowse());

    const recent = await firstValueFrom(vm.recentResources$);
    expect(recent).toEqual([{ '@id': 'r1' }]);

    vm.dispose();
  });

  it('exposes entity types from browse namespace', async () => {
    const vm = createDiscoverVM(mockClient(), mockBrowse());

    const types = await firstValueFrom(vm.entityTypes$);
    expect(types).toEqual(['Person']);

    vm.dispose();
  });

  it('reports loading when resources are undefined', async () => {
    const resources$ = new BehaviorSubject<unknown[] | undefined>(undefined);
    const vm = createDiscoverVM(mockClient({ resources$ }), mockBrowse());

    const loading = await firstValueFrom(vm.isLoadingRecent$);
    expect(loading).toBe(true);

    resources$.next([]);
    const loaded = await firstValueFrom(vm.isLoadingRecent$.pipe(filter((l) => !l)));
    expect(loaded).toBe(false);

    vm.dispose();
  });

  it('exposes a search pipeline', () => {
    const vm = createDiscoverVM(mockClient(), mockBrowse());

    expect(vm.search).toBeDefined();
    expect(typeof vm.search.setQuery).toBe('function');
    expect(vm.search.state$).toBeDefined();

    vm.dispose();
  });

  it('disposes browse and search on dispose', () => {
    const browse = mockBrowse();
    const vm = createDiscoverVM(mockClient(), browse);
    vm.dispose();

    expect(browse.dispose).toHaveBeenCalled();
  });
});
