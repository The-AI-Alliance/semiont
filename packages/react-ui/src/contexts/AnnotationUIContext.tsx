'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import type { AnnotationUri } from '@semiont/api-client';

interface AnnotationUIContextType {
  // UI state for sparkle animations
  newAnnotationIds: Set<string>;

  // UI actions
  clearNewAnnotationId: (id: AnnotationUri) => void;
  triggerSparkleAnimation: (annotationId: string) => void;
}

const AnnotationUIContext = createContext<AnnotationUIContextType | undefined>(undefined);

export interface AnnotationUIProviderProps {
  children: React.ReactNode;
}

/**
 * Annotation UI Provider
 *
 * Manages UI-only state for annotation interactions (sparkle animations).
 * This is NOT part of the Provider Pattern - it's internal react-ui state management.
 *
 * Usage:
 * ```typescript
 * <AnnotationUIProvider>
 *   <ResourceViewer ... />
 * </AnnotationUIProvider>
 * ```
 */
export function AnnotationUIProvider({ children }: AnnotationUIProviderProps) {
  const [newAnnotationIds, setNewAnnotationIds] = useState<Set<string>>(new Set());

  const clearNewAnnotationId = useCallback((id: AnnotationUri) => {
    setNewAnnotationIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const triggerSparkleAnimation = useCallback((annotationId: string) => {
    setNewAnnotationIds(prev => new Set(prev).add(annotationId));

    // Clear after animation completes (6 seconds for 3 iterations)
    setTimeout(() => {
      setNewAnnotationIds(prev => {
        const next = new Set(prev);
        next.delete(annotationId);
        return next;
      });
    }, 6000);
  }, []);

  return (
    <AnnotationUIContext.Provider
      value={{
        newAnnotationIds,
        clearNewAnnotationId,
        triggerSparkleAnimation,
      }}
    >
      {children}
    </AnnotationUIContext.Provider>
  );
}

/**
 * Hook to access annotation UI state
 *
 * @throws Error if used outside AnnotationUIProvider
 * @returns AnnotationUI context
 */
export function useAnnotationUI(): AnnotationUIContextType {
  const context = useContext(AnnotationUIContext);
  if (!context) {
    throw new Error('useAnnotationUI must be used within an AnnotationUIProvider');
  }
  return context;
}
