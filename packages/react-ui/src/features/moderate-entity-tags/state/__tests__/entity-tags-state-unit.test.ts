import { describe, it, expect, vi } from 'vitest';
import { sessionOf } from '../../../../__tests__/test-client';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontClient } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../../state/shell-state-unit';
import { createEntityTagsStateUnit } from '../entity-tags-state-unit';
import { assertStateUnitAxioms, disposeProbe } from '@semiont/core/testing';

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
    const stateUnit = createEntityTagsStateUnit(sessionOf(mockClient()), mockBrowse());

    const types = await firstValueFrom(stateUnit.entityTypes.value$);
    expect(types).toEqual(['Person', 'Place']);

    stateUnit.dispose();
  });

  it('reports loading when entity types are undefined', async () => {
    const entityTypes$ = new BehaviorSubject<string[] | undefined>(undefined);
    const stateUnit = createEntityTagsStateUnit(sessionOf(mockClient({ entityTypes$ })), mockBrowse());

    const loading = await firstValueFrom(stateUnit.entityTypes.loading$);
    expect(loading).toBe(true);

    entityTypes$.next(['Tag']);
    const loaded = await firstValueFrom(stateUnit.entityTypes.loading$.pipe(filter((l) => !l)));
    expect(loaded).toBe(false);

    stateUnit.dispose();
  });

  it('setNewTag updates newTag$', async () => {
    const stateUnit = createEntityTagsStateUnit(sessionOf(mockClient()), mockBrowse());

    stateUnit.setNewTag('Organization');
    const tag = await firstValueFrom(stateUnit.newTag$);
    expect(tag).toBe('Organization');

    stateUnit.dispose();
  });

  it('addTag calls client and clears newTag$', async () => {
    const addEntityType = vi.fn().mockResolvedValue(undefined);
    const stateUnit = createEntityTagsStateUnit(sessionOf(mockClient({ addEntityType })), mockBrowse());

    stateUnit.setNewTag('Event');
    await stateUnit.addTag();

    expect(addEntityType).toHaveBeenCalledWith('Event');
    const tag = await firstValueFrom(stateUnit.newTag$);
    expect(tag).toBe('');

    stateUnit.dispose();
  });

  it('addTag ignores empty/whitespace input', async () => {
    const addEntityType = vi.fn();
    const stateUnit = createEntityTagsStateUnit(sessionOf(mockClient({ addEntityType })), mockBrowse());

    stateUnit.setNewTag('   ');
    await stateUnit.addTag();

    expect(addEntityType).not.toHaveBeenCalled();

    stateUnit.dispose();
  });

  it('addTag sets error on failure', async () => {
    const addEntityType = vi.fn().mockRejectedValue(new Error('duplicate'));
    const stateUnit = createEntityTagsStateUnit(sessionOf(mockClient({ addEntityType })), mockBrowse());

    stateUnit.setNewTag('Person');
    await stateUnit.addTag();

    const error = await firstValueFrom(stateUnit.error$);
    expect(error).toBe('duplicate');

    const adding = await firstValueFrom(stateUnit.isAdding$);
    expect(adding).toBe(false);

    stateUnit.dispose();
  });
});

describe('EntityTagsStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms (incl. A7-passed: never disposes the injected browse)', () => {
    assertStateUnitAxioms({
      setup: () => {
        const browse = disposeProbe();
        return { unit: createEntityTagsStateUnit(sessionOf(mockClient()), browse as unknown as ShellStateUnit), passedIn: [browse] };
      },
      surfaces: (u) => [u.newTag$, u.error$, u.isAdding$],
      invocations: (u) => [() => u.setNewTag(''), () => u.addTag()],
    });
  });
});

describe('createEntityTagsStateUnit — terminal load failure', () => {
  // `isLoading$` was `raw$.pipe(map(e => e === undefined))` and
  // moderate/entity-tags/page.tsx returns a full-page loading screen off it,
  // so a failed load froze the route. The existing `error$` is the ADD-tag
  // error and is deliberately left alone.
  // See .plans/PANEL-FAILURE-STATES.md

  it('stops loading and surfaces the load failure, distinct from the add-tag error', async () => {
    const entityTypes$ = new BehaviorSubject<string[] | undefined>(undefined);
    const unit = createEntityTagsStateUnit(sessionOf(mockClient({ entityTypes$ })), mockBrowse());

    expect(await firstValueFrom(unit.entityTypes.loading$)).toBe(true);
    entityTypes$.error(new Error('Resource not found'));

    expect(await firstValueFrom(unit.entityTypes.loading$)).toBe(false);
    expect(await firstValueFrom(unit.entityTypes.error$)).not.toBeNull();
    // The add-tag error channel is untouched by a load failure.
    expect(await firstValueFrom(unit.error$)).toBe('');

    unit.dispose();
  });
});
