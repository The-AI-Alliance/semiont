'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { ResourceId } from '@semiont/core';

interface OpenResource {
  id: ResourceId;
  name: string;
  openedAt: number;
  order?: number; // Optional for backward compatibility
}

interface OpenResourcesContextType {
  openResources: OpenResource[];
  addResource: (id: ResourceId, name: string) => void;
  removeResource: (id: ResourceId) => void;
  updateResourceName: (id: ResourceId, name: string) => void;
  reorderResources: (oldIndex: number, newIndex: number) => void;
}

const OpenResourcesContext = createContext<OpenResourcesContextType | undefined>(undefined);

export function OpenResourcesProvider({ children }: { children: React.ReactNode }) {
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
  
  const addResource = useCallback((id: ResourceId, name: string) => {
    setOpenResources(prev => {
      const existing = prev.find(resource => resource.id === id);
      if (existing) {
        // Update name if resource already exists
        return prev.map(resource =>
          resource.id === id ? { ...resource, name } : resource
        );
      }
      // Add new resource with order = max order + 1
      const maxOrder = prev.length > 0
        ? Math.max(...prev.map(r => r.order ?? r.openedAt))
        : 0;
      return [...prev, { id, name, openedAt: Date.now(), order: maxOrder + 1 }];
    });
  }, []);

  const removeResource = useCallback((id: ResourceId) => {
    setOpenResources(prev => prev.filter(resource => resource.id !== id));
  }, []);

  const updateResourceName = useCallback((id: ResourceId, name: string) => {
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

  return (
    <OpenResourcesContext.Provider value={{
      openResources,
      addResource,
      removeResource,
      updateResourceName,
      reorderResources
    }}>
      {children}
    </OpenResourcesContext.Provider>
  );
}

export function useOpenResources() {
  const context = useContext(OpenResourcesContext);
  if (context === undefined) {
    throw new Error('useOpenResources must be used within an OpenResourcesProvider');
  }
  return context;
}