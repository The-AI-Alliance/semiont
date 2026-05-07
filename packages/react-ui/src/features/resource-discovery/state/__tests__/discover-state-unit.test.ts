import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontClient } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../../state/shell-state-unit';
import { createDiscoverStateUnit } from '../discover-state-unit';

function mockBrowse(): ShellStateUnit {
  return { dispose: vi.fn() } as unknown as ShellStateUnit;
}

function mockClient(overrides: {
  resources$?: BehaviorSubject<unknown[] | undefined>;
  entityTypes$?: BehaviorSubject<string[] | undefined>;
} = {}): SemiontClient {
  const resources$ = overrides.resources$ ?? new BehaviorSubject<unknown[] | undefined>([{ '@id': 'r1' }]);
  const entityTypes$ = overrides.entityTypes$ ?? new BehaviorSubject<string[] | undefined>(['Person']);
  return {
    browse: {
      resources: () => resources$.asObservable(),
      entityTypes: () => entityTypes$.asObservable(),
    },
  } as unknown as SemiontClient;
}

describe('createDiscoverStateUnit', () => {
  it('exposes recent resources from browse namespace', async () => {
    const stateUnit = createDiscoverStateUnit(mockClient(), mockBrowse());

    const recent = await firstValueFrom(stateUnit.recentResources$);
    expect(recent).toEqual([{ '@id': 'r1' }]);

    stateUnit.dispose();
  });

  it('exposes entity types from browse namespace', async () => {
    const stateUnit = createDiscoverStateUnit(mockClient(), mockBrowse());

    const types = await firstValueFrom(stateUnit.entityTypes$);
    expect(types).toEqual(['Person']);

    stateUnit.dispose();
  });

  it('reports loading when resources are undefined', async () => {
    const resources$ = new BehaviorSubject<unknown[] | undefined>(undefined);
    const stateUnit = createDiscoverStateUnit(mockClient({ resources$ }), mockBrowse());

    const loading = await firstValueFrom(stateUnit.isLoadingRecent$);
    expect(loading).toBe(true);

    resources$.next([]);
    const loaded = await firstValueFrom(stateUnit.isLoadingRecent$.pipe(filter((l) => !l)));
    expect(loaded).toBe(false);

    stateUnit.dispose();
  });

  it('exposes a search pipeline', () => {
    const stateUnit = createDiscoverStateUnit(mockClient(), mockBrowse());

    expect(stateUnit.search).toBeDefined();
    expect(typeof stateUnit.search.setQuery).toBe('function');
    expect(stateUnit.search.state$).toBeDefined();

    stateUnit.dispose();
  });

  it('disposes browse and search on dispose', () => {
    const browse = mockBrowse();
    const stateUnit = createDiscoverStateUnit(mockClient(), browse);
    stateUnit.dispose();

    expect(browse.dispose).toHaveBeenCalled();
  });
});
