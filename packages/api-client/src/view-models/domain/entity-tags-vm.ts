import { BehaviorSubject, type Observable, map } from 'rxjs';
import type { EntityType } from '@semiont/core';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { BrowseVM } from '../flows/browse-vm';
import type { SemiontApiClient } from '../../client';

export interface EntityTagsVM extends ViewModel {
  browse: BrowseVM;
  entityTypes$: Observable<string[]>;
  isLoading$: Observable<boolean>;
  newTag$: Observable<string>;
  error$: Observable<string>;
  isAdding$: Observable<boolean>;
  setNewTag(value: string): void;
  addTag(): Promise<void>;
}

export function createEntityTagsVM(
  client: SemiontApiClient,
  browse: BrowseVM,
): EntityTagsVM {
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
      await client.addEntityType(tag as EntityType);
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
