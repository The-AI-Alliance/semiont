'use client';

import React, { createContext, useContext } from 'react';
import type { ResourceUri } from '@semiont/api-client';
import type {
  AnnotationsCollection,
  AnnotationHandlers,
  AnnotationUIState,
  AnnotationConfig
} from '@/types/annotation-props';

/**
 * Context for annotation-related data and handlers.
 * Eliminates prop drilling through intermediate components.
 */
export interface AnnotationContextValue {
  /** W3C canonical URI of the resource being annotated */
  resourceUri: ResourceUri;

  /** All annotations for this resource, grouped by type */
  annotations: AnnotationsCollection;

  /** Event handlers for annotation interactions */
  handlers: AnnotationHandlers;

  /** Current UI state (toolbar selections, hover state, etc.) */
  uiState: AnnotationUIState;

  /** Configuration options for annotation views */
  config: AnnotationConfig;
}

const AnnotationContext = createContext<AnnotationContextValue | null>(null);

export interface AnnotationProviderProps {
  value: AnnotationContextValue;
  children: React.ReactNode;
}

/**
 * Provider component for annotation context.
 * Should be rendered by ResourceViewer to provide annotation data to deep components.
 */
export function AnnotationProvider({ value, children }: AnnotationProviderProps) {
  return (
    <AnnotationContext.Provider value={value}>
      {children}
    </AnnotationContext.Provider>
  );
}

/**
 * Hook to access annotation context.
 * Throws an error if used outside of AnnotationProvider.
 */
export function useAnnotationContext(): AnnotationContextValue {
  const context = useContext(AnnotationContext);
  if (!context) {
    throw new Error('useAnnotationContext must be used within an AnnotationProvider');
  }
  return context;
}
