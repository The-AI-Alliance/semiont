import { useMemo, useEffect } from 'react';
import type { OpenResourcesManager } from '@semiont/react-ui';
import { useObservable } from '@semiont/react-ui';
import { OpenResourcesStore } from '@/stores/open-resources-store';

/**
 * Hook that provides OpenResourcesManager delegating to OpenResourcesStore.
 * State lives in a BehaviorSubject; React re-renders via useObservable subscription.
 */
export function useOpenResourcesManager(): OpenResourcesManager {
  const store = useMemo(() => new OpenResourcesStore(), []);

  useEffect(() => () => store.destroy(), [store]);

  const openResources = useObservable(store.resources$) ?? store.resources;

  return useMemo(
    () => ({
      openResources,
      addResource: (id: string, name: string, mediaType?: string, storageUri?: string) =>
        store.add(id, name, mediaType, storageUri),
      removeResource: (id: string) => store.remove(id),
      updateResourceName: (id: string, name: string) => store.updateName(id, name),
      reorderResources: (oldIndex: number, newIndex: number) => store.reorder(oldIndex, newIndex),
    }),
    [store, openResources],
  );
}
