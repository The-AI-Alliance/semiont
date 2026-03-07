'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { OpenResource, OpenResourcesManager } from '@semiont/react-ui';

/**
 * Hook that provides OpenResourcesManager implementation using localStorage
 * This is the app-level implementation that gets passed to components as props
 */
export function useOpenResourcesManager(): OpenResourcesManager {
  const [openResources, setOpenResources] = useState<OpenResource[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('openDocuments');
    if (stored) {
      try {
        const resources = JSON.parse(stored) as OpenResource[];
        // Sort by order if present, otherwise by openedAt (for backward compatibility)
        setOpenResources(resources.sort((a, b) => {
          if (a.order !== undefined && b.order !== undefined) {
            return a.order - b.order;
          }
          return a.openedAt - b.openedAt;
        }));
      } catch (e) {
        console.error('Failed to parse open resources:', e);
      }
    }
    setIsInitialized(true);
  }, []);

  // Save to localStorage whenever resources change (but not on initial mount)
  useEffect(() => {
    if (isInitialized) {
      localStorage.setItem('openDocuments', JSON.stringify(openResources));
    }
  }, [openResources, isInitialized]);

  // Listen for storage events from other tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'openDocuments' && e.newValue) {
        try {
          const resources = JSON.parse(e.newValue) as OpenResource[];
          // Sort by order if present, otherwise by openedAt
          setOpenResources(resources.sort((a, b) => {
            if (a.order !== undefined && b.order !== undefined) {
              return a.order - b.order;
            }
            return a.openedAt - b.openedAt;
          }));
        } catch (err) {
          console.error('Failed to parse open resources from storage event:', err);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const addResource = useCallback((id: string, name: string, mediaType?: string) => {
    setOpenResources(prev => {
      const existing = prev.find(resource => resource.id === id);
      if (existing) {
        // Update name and mediaType if resource already exists
        return prev.map(resource =>
          resource.id === id ? { ...resource, name, ...(mediaType && { mediaType }) } : resource
        );
      }
      // Add new resource with order = max order + 1
      const maxOrder = prev.length > 0
        ? Math.max(...prev.map(r => r.order ?? r.openedAt))
        : 0;
      return [...prev, { id, name, openedAt: Date.now(), order: maxOrder + 1, ...(mediaType && { mediaType }) }];
    });
  }, []);

  const removeResource = useCallback((id: string) => {
    setOpenResources(prev => prev.filter(resource => resource.id !== id));
  }, []);

  const updateResourceName = useCallback((id: string, name: string) => {
    setOpenResources(prev =>
      prev.map(resource => resource.id === id ? { ...resource, name } : resource)
    );
  }, []);

  const reorderResources = useCallback((oldIndex: number, newIndex: number) => {
    setOpenResources(prev => {
      const reordered = arrayMove(prev, oldIndex, newIndex);
      // Update order field to preserve the new position
      return reordered.map((resource, index) => ({
        ...resource,
        order: index
      }));
    });
  }, []);

  return useMemo(
    () => ({
      openResources,
      addResource,
      removeResource,
      updateResourceName,
      reorderResources
    }),
    [openResources, addResource, removeResource, updateResourceName, reorderResources]
  );
}
