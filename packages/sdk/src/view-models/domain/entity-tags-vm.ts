import { BehaviorSubject, type Observable, map } from 'rxjs';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { ShellVM } from '../flows/shell-vm';
import type { SemiontClient } from '../../client';

export interface EntityTagsVM extends ViewModel {
  browse: ShellVM;
  entityTypes$: Observable<string[]>;
  isLoading$: Observable<boolean>;
  newTag$: Observable<string>;
  error$: Observable<string>;
  isAdding$: Observable<boolean>;
  setNewTag(value: string): void;
  addTag(): Promise<void>;
}

export function createEntityTagsVM(
  client: SemiontClient,
  browse: ShellVM,
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
      await client.mark.entityType(tag);
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
