'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { api } from '@/lib/api-client';
import { useAuthenticatedAPI } from '@/hooks/useAuthenticatedAPI';
import type { Annotation } from '@semiont/core-types';

// Use core-types Annotation as single source of truth
// (re-export for convenience)
export type { Annotation } from '@semiont/core-types';

interface DocumentAnnotationsContextType {
  // UI state only - data comes from React Query hooks in components
  newAnnotationIds: Set<string>; // Track recently created annotations for sparkle animations

  // Mutation actions (still in context for consistency)
  addHighlight: (documentId: string, text: string, position: { start: number; end: number }) => Promise<string | undefined>;
  addReference: (documentId: string, text: string, position: { start: number; end: number }, targetDocId?: string, entityType?: string, referenceType?: string) => Promise<string | undefined>;
  deleteAnnotation: (annotationId: string, documentId: string) => Promise<void>;
  convertHighlightToReference: (highlights: Annotation[], highlightId: string, targetDocId?: string, entityType?: string, referenceType?: string) => Promise<void>;
  convertReferenceToHighlight: (references: Annotation[], referenceId: string) => Promise<void>;

  // UI actions
  clearNewAnnotationId: (id: string) => void;
  triggerSparkleAnimation: (annotationId: string) => void;
}

const DocumentAnnotationsContext = createContext<DocumentAnnotationsContextType | undefined>(undefined);

export function DocumentAnnotationsProvider({ children }: { children: React.ReactNode }) {
  // UI state only - no data management
  const [newAnnotationIds, setNewAnnotationIds] = useState<Set<string>>(new Set());

  // Set up mutation hooks
  const saveHighlightMutation = api.selections.saveAsHighlight.useMutation();
  const createSelectionMutation = api.selections.create.useMutation();
  const deleteSelectionMutation = api.selections.delete.useMutation();

  const addHighlight = useCallback(async (
    documentId: string,
    text: string,
    position: { start: number; end: number }
  ): Promise<string | undefined> => {
    try {
      const result = await saveHighlightMutation.mutateAsync({
        documentId,
        text,
        position
      });

      // Track this as a new annotation for sparkle animation
      let newId: string | undefined;
      if (result.selection?.id) {
        newId = result.selection.id;
        setNewAnnotationIds(prev => new Set(prev).add(newId!));

        // Clear the ID after animation completes (6 seconds for 3 iterations)
        setTimeout(() => {
          setNewAnnotationIds(prev => {
            const next = new Set(prev);
            next.delete(newId!);
            return next;
          });
        }, 6000);
      }

      // Return the new ID so component can invalidate queries
      return newId;
    } catch (err) {
      console.error('Failed to create highlight:', err);
      throw err;
    }
  }, [saveHighlightMutation]);

  const addReference = useCallback(async (
    documentId: string,
    text: string,
    position: { start: number; end: number },
    targetDocId?: string,
    entityType?: string,
    referenceType?: string
  ): Promise<string | undefined> => {
    try {
      // Build the create selection request with all metadata
      const createData: any = {
        documentId,
        text,
        position
      };

      // For references (both stub and resolved)
      if (targetDocId !== undefined || referenceType || entityType) {
        // Include resolvedDocumentId key (null for stubs, string for resolved)
        createData.resolvedDocumentId = targetDocId || null;

        if (entityType) {
          // Entity types is an array of strings
          createData.entityTypes = entityType.split(',').map((t: string) => t.trim()).filter((t: string) => t);
        }
        if (referenceType) {
          // Reference tags is an array, but we have a single reference type
          createData.referenceTags = [referenceType];
        }
      }

      // Create the selection with metadata
      const result = await createSelectionMutation.mutateAsync(createData);

      // Track this as a new annotation for sparkle animation
      let newId: string | undefined;
      if (result.selection?.id) {
        newId = result.selection.id;
        setNewAnnotationIds(prev => new Set(prev).add(newId!));

        // Clear the ID after animation completes (6 seconds for 3 iterations)
        setTimeout(() => {
          setNewAnnotationIds(prev => {
            const next = new Set(prev);
            next.delete(newId!);
            return next;
          });
        }, 6000);
      }

      // Return the new ID so component can invalidate queries
      return newId;
    } catch (err) {
      console.error('Failed to create reference:', err);
      throw err;
    }
  }, [createSelectionMutation]);

  const deleteAnnotation = useCallback(async (annotationId: string, documentId: string) => {
    try {
      await deleteSelectionMutation.mutateAsync({ id: annotationId, documentId });
      // Component will invalidate queries to refetch data
    } catch (err) {
      console.error('Failed to delete annotation:', err);
      throw err;
    }
  }, [deleteSelectionMutation]);

  const convertHighlightToReference = useCallback(async (
    highlights: Annotation[],
    highlightId: string,
    targetDocId?: string,
    entityType?: string,
    referenceType?: string
  ) => {
    const highlight = highlights.find(h => h.id === highlightId);
    if (!highlight || !highlight.selectionData) return;

    try {
      // Delete the highlight
      await deleteSelectionMutation.mutateAsync({ id: highlightId });

      // Create new reference
      await addReference(
        highlight.documentId,
        highlight.selectionData.text,
        {
          start: highlight.selectionData.offset,
          end: highlight.selectionData.offset + highlight.selectionData.length
        },
        targetDocId,
        entityType,
        referenceType
      );
      // Component will invalidate queries to refetch data
    } catch (err) {
      console.error('Failed to convert highlight to reference:', err);
      throw err;
    }
  }, [addReference, deleteSelectionMutation]);

  const convertReferenceToHighlight = useCallback(async (
    references: Annotation[],
    referenceId: string
  ) => {
    const reference = references.find(r => r.id === referenceId);
    if (!reference || !reference.selectionData) return;

    try {
      // Delete the reference
      await deleteSelectionMutation.mutateAsync({ id: referenceId });

      // Create new highlight
      await addHighlight(
        reference.documentId,
        reference.selectionData.text,
        {
          start: reference.selectionData.offset,
          end: reference.selectionData.offset + reference.selectionData.length
        }
      );
      // Component will invalidate queries to refetch data
    } catch (err) {
      console.error('Failed to convert reference to highlight:', err);
      throw err;
    }
  }, [addHighlight, deleteSelectionMutation]);

  const clearNewAnnotationId = useCallback((id: string) => {
    setNewAnnotationIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const triggerSparkleAnimation = useCallback((annotationId: string) => {
    // Add the ID to trigger sparkle animation
    setNewAnnotationIds(prev => new Set(prev).add(annotationId));

    // Remove it after animation completes (6 seconds for 3 iterations)
    setTimeout(() => {
      setNewAnnotationIds(prev => {
        const next = new Set(prev);
        next.delete(annotationId);
        return next;
      });
    }, 6000);
  }, []);

  return (
    <DocumentAnnotationsContext.Provider value={{
      newAnnotationIds,
      addHighlight,
      addReference,
      deleteAnnotation,
      convertHighlightToReference,
      convertReferenceToHighlight,
      clearNewAnnotationId,
      triggerSparkleAnimation
    }}>
      {children}
    </DocumentAnnotationsContext.Provider>
  );
}

export function useDocumentAnnotations() {
  const context = useContext(DocumentAnnotationsContext);
  if (context === undefined) {
    throw new Error('useDocumentAnnotations must be used within a DocumentAnnotationsProvider');
  }
  return context;
}