import { BehaviorSubject, type Observable } from 'rxjs';
import { createDisposer } from '@semiont/sdk';
import type { StateUnit } from '@semiont/core';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import { trackList, type ListState } from '../../../state/list-state';
import type { SemiontSession } from '@semiont/sdk';

export interface EntityTagsStateUnit extends StateUnit {
  browse: ShellStateUnit;
  entityTypes: ListState<string[]>;
  newTag$: Observable<string>;
  error$: Observable<string>;
  isAdding$: Observable<boolean>;
  setNewTag(value: string): void;
  addTag(): Promise<void>;
}

export function createEntityTagsStateUnit(
  session: SemiontSession,
  browse: ShellStateUnit,
): EntityTagsStateUnit {
  const { client } = session;
  const disposer = createDisposer();
  // `browse` (ShellStateUnit) is a *passed-in* dependency owned by the caller
  // (`useShellStateUnit`), not this unit — do NOT add it to the disposer (it's the
  // shared, app-scoped shell). See packages/sdk/docs/STATE-UNITS.md (composition rule).

  const newTag$ = new BehaviorSubject<string>('');
  const error$ = new BehaviorSubject<string>('');
  const isAdding$ = new BehaviorSubject<boolean>(false);

  const entityTypes = trackList<string[]>(() => client.browse.entityTypes(), []);
  disposer.add(entityTypes.dispose);

  const addTag = async (): Promise<void> => {
    const tag = newTag$.getValue().trim();
    if (!tag) return;
    error$.next('');
    isAdding$.next(true);
    try {
      await client.frame.addEntityType(tag);
      newTag$.next('');
    } catch (err) {
      error$.next(err instanceof Error ? err.message : 'Failed to add entity type');
    } finally {
      isAdding$.next(false);
    }
  };

  return {
    browse,
    entityTypes: entityTypes.state,
    newTag$: newTag$.asObservable(),
    error$: error$.asObservable(),
    isAdding$: isAdding$.asObservable(),
    setNewTag: (v) => newTag$.next(v),
    addTag,
    dispose: () => {
      newTag$.complete();
      error$.complete();
      isAdding$.complete();
      disposer.dispose();
    },
  };
}
