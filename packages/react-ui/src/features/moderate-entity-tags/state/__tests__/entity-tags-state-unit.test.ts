import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontClient } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../../state/shell-state-unit';
import { createEntityTagsStateUnit } from '../entity-tags-state-unit';

function mockBrowse(): ShellStateUnit {
  return { dispose: vi.fn() } as unknown as ShellStateUnit;
}

function mockClient(overrides: {
  entityTypes$?: BehaviorSubject<string[] | undefined>;
  addEntityType?: ReturnType<typeof vi.fn>;
} = {}): SemiontClient {
  const entityTypes$ = overrides.entityTypes$ ?? new BehaviorSubject<string[] | undefined>(['Person', 'Place']);
  return {
    browse: {
      entityTypes: () => entityTypes$.asObservable(),
    },
    frame: {
      addEntityType: overrides.addEntityType ?? vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as SemiontClient;
}

describe('createEntityTagsStateUnit', () => {
  it('exposes entity types from browse namespace', async () => {
    const stateUnit = createEntityTagsStateUnit(mockClient(), mockBrowse());

    const types = await firstValueFrom(stateUnit.entityTypes$);
    expect(types).toEqual(['Person', 'Place']);

    stateUnit.dispose();
  });

  it('reports loading when entity types are undefined', async () => {
    const entityTypes$ = new BehaviorSubject<string[] | undefined>(undefined);
    const stateUnit = createEntityTagsStateUnit(mockClient({ entityTypes$ }), mockBrowse());

    const loading = await firstValueFrom(stateUnit.isLoading$);
    expect(loading).toBe(true);

    entityTypes$.next(['Tag']);
    const loaded = await firstValueFrom(stateUnit.isLoading$.pipe(filter((l) => !l)));
    expect(loaded).toBe(false);

    stateUnit.dispose();
  });

  it('setNewTag updates newTag$', async () => {
    const stateUnit = createEntityTagsStateUnit(mockClient(), mockBrowse());

    stateUnit.setNewTag('Organization');
    const tag = await firstValueFrom(stateUnit.newTag$);
    expect(tag).toBe('Organization');

    stateUnit.dispose();
  });

  it('addTag calls client and clears newTag$', async () => {
    const addEntityType = vi.fn().mockResolvedValue(undefined);
    const stateUnit = createEntityTagsStateUnit(mockClient({ addEntityType }), mockBrowse());

    stateUnit.setNewTag('Event');
    await stateUnit.addTag();

    expect(addEntityType).toHaveBeenCalledWith('Event');
    const tag = await firstValueFrom(stateUnit.newTag$);
    expect(tag).toBe('');

    stateUnit.dispose();
  });

  it('addTag ignores empty/whitespace input', async () => {
    const addEntityType = vi.fn();
    const stateUnit = createEntityTagsStateUnit(mockClient({ addEntityType }), mockBrowse());

    stateUnit.setNewTag('   ');
    await stateUnit.addTag();

    expect(addEntityType).not.toHaveBeenCalled();

    stateUnit.dispose();
  });

  it('addTag sets error on failure', async () => {
    const addEntityType = vi.fn().mockRejectedValue(new Error('duplicate'));
    const stateUnit = createEntityTagsStateUnit(mockClient({ addEntityType }), mockBrowse());

    stateUnit.setNewTag('Person');
    await stateUnit.addTag();

    const error = await firstValueFrom(stateUnit.error$);
    expect(error).toBe('duplicate');

    const adding = await firstValueFrom(stateUnit.isAdding$);
    expect(adding).toBe(false);

    stateUnit.dispose();
  });
});
