import { BehaviorSubject, type Observable, map } from 'rxjs';
import { createDisposer } from '@semiont/sdk';
import type { StateUnit } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import type { SemiontClient } from '@semiont/sdk';

export interface EntityTagsStateUnit extends StateUnit {
  browse: ShellStateUnit;
  entityTypes$: Observable<string[]>;
  isLoading$: Observable<boolean>;
  newTag$: Observable<string>;
  error$: Observable<string>;
  isAdding$: Observable<boolean>;
  setNewTag(value: string): void;
  addTag(): Promise<void>;
}

export function createEntityTagsStateUnit(
  client: SemiontClient,
  browse: ShellStateUnit,
): EntityTagsStateUnit {
  const disposer = createDisposer();
  disposer.add(browse);

  const newTag$ = new BehaviorSubject<string>('');
  const error$ = new BehaviorSubject<string>('');
  const isAdding$ = new BehaviorSubject<boolean>(false);

  const raw$ = client.browse.entityTypes();
  const entityTypes$: Observable<string[]> = raw$.pipe(map((e) => e ?? []));
  const isLoading$: Observable<boolean> = raw$.pipe(map((e) => e === undefined));

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
    entityTypes$,
    isLoading$,
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
