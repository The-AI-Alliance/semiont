'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { useAuthenticatedAPI } from '@/hooks/useAuthenticatedAPI';
import type { Annotation, CreateAnnotationRequest } from '@/lib/api';
import { getExactText, getTextPositionSelector } from '@/lib/api';

interface DocumentAnnotationsContextType {
  // UI state only - data comes from React Query hooks in components
  newAnnotationIds: Set<string>; // Track recently created annotations for sparkle animations

  // Mutation actions (still in context for consistency)
  addHighlight: (documentId: string, exact: string, position: { start: number; end: number }) => Promise<string | undefined>;
  addReference: (documentId: string, exact: string, position: { start: number; end: number }, targetDocId?: string, entityType?: string, referenceType?: string) => Promise<string | undefined>;
  addAssessment: (documentId: string, exact: string, position: { start: number; end: number }) => Promise<string | undefined>;
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
  const saveHighlightMutation = api.annotations.saveAsHighlight.useMutation();
  const createAnnotationMutation = api.annotations.create.useMutation();
  const deleteAnnotationMutation = api.annotations.delete.useMutation();

  const addHighlight = useCallback(async (
    documentId: string,
    exact: string,
    position: { start: number; end: number }
  ): Promise<string | undefined> => {
    try {
      const result = await saveHighlightMutation.mutateAsync({
        documentId,
        exact,
        position
      });

      // Track this as a new annotation for sparkle animation
      let newId: string | undefined;
      if (result.annotation?.id) {
        newId = result.annotation.id;
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
    exact: string,
    position: { start: number; end: number },
    targetDocId?: string,
    entityType?: string,
    referenceType?: string
  ): Promise<string | undefined> => {
    try {
      // Build CreateAnnotationRequest following W3C Web Annotation format
      const createData: CreateAnnotationRequest = {
        target: {
          source: documentId,
          selector: {
            type: 'TextPositionSelector',
            exact: exact,
            offset: position.start,
            length: position.end - position.start,
          },
        },
        body: {
          type: 'SpecificResource',
          source: targetDocId !== undefined ? (targetDocId || null) : null,
          entityTypes: entityType
            ? entityType.split(',').map((t: string) => t.trim()).filter((t: string) => t)
            : [],
        },
      };

      // Create the annotation
      const result = await createAnnotationMutation.mutateAsync(createData);

      // Track this as a new annotation for sparkle animation
      let newId: string | undefined;
      if (result.annotation?.id) {
        newId = result.annotation.id;
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
  }, [createAnnotationMutation]);

  const addAssessment = useCallback(async (
    documentId: string,
    exact: string,
    position: { start: number; end: number }
  ): Promise<string | undefined> => {
    try {
      // Build CreateAnnotationRequest following W3C Web Annotation format
      // Assessment uses motivation: 'assessing'
      const createData: CreateAnnotationRequest = {
        motivation: 'assessing',  // W3C motivation for assessments
        target: {
          source: documentId,
          selector: {
            type: 'TextPositionSelector',
            exact: exact,
            offset: position.start,
            length: position.end - position.start,
          },
        },
        body: {
          type: 'TextualBody',  // Assessments use TextualBody like highlights
          // value can be added later
        },
      };

      // Create the annotation
      const result = await createAnnotationMutation.mutateAsync(createData);

      // Track this as a new annotation for sparkle animation
      let newId: string | undefined;
      if (result.annotation?.id) {
        newId = result.annotation.id;
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
      console.error('Failed to create assessment:', err);
      throw err;
    }
  }, [createAnnotationMutation]);

  const deleteAnnotation = useCallback(async (annotationId: string, documentId: string) => {
    try {
      await deleteAnnotationMutation.mutateAsync({ id: annotationId, documentId });
    } catch (err) {
      console.error('Failed to delete annotation:', err);
      throw err;
    }
  }, [deleteAnnotationMutation]);

  const convertHighlightToReference = useCallback(async (
    highlights: Annotation[],
    highlightId: string,
    targetDocId?: string,
    entityType?: string,
    referenceType?: string
  ) => {
    try {
      // Find the highlight
      const highlight = highlights.find(h => h.id === highlightId);
      if (!highlight) {
        throw new Error('Highlight not found');
      }

      // Delete old highlight (documentId required for Layer 3 lookup)
      await deleteAnnotationMutation.mutateAsync({
        id: highlightId,
        documentId: highlight.target.source
      });

      // Create new reference with same position
      const posSelector = getTextPositionSelector(highlight.target.selector);
      if (!posSelector) {
        throw new Error('Cannot convert highlight to reference: TextPositionSelector required');
      }
      await addReference(
        highlight.target.source,
        getExactText(highlight.target.selector),
        { start: posSelector.offset, end: posSelector.offset + posSelector.length },
        targetDocId,
        entityType,
        referenceType
      );
    } catch (err) {
      console.error('Failed to convert highlight to reference:', err);
      throw err;
    }
  }, [addReference, deleteAnnotationMutation]);

  const convertReferenceToHighlight = useCallback(async (references: Annotation[], referenceId: string) => {
    try {
      // Find the reference
      const reference = references.find(r => r.id === referenceId);
      if (!reference) {
        throw new Error('Reference not found');
      }

      // Delete old reference (documentId required for Layer 3 lookup)
      await deleteAnnotationMutation.mutateAsync({
        id: referenceId,
        documentId: reference.target.source
      });

      // Create new highlight with same position
      const posSelector = getTextPositionSelector(reference.target.selector);
      if (!posSelector) {
        throw new Error('Cannot convert reference to highlight: TextPositionSelector required');
      }
      await addHighlight(
        reference.target.source,
        getExactText(reference.target.selector),
        { start: posSelector.offset, end: posSelector.offset + posSelector.length }
      );
    } catch (err) {
      console.error('Failed to convert reference to highlight:', err);
      throw err;
    }
  }, [addHighlight, deleteAnnotationMutation]);

  const clearNewAnnotationId = useCallback((id: string) => {
    setNewAnnotationIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const triggerSparkleAnimation = useCallback((annotationId: string) => {
    setNewAnnotationIds(prev => new Set(prev).add(annotationId));

    // Clear after animation
    setTimeout(() => {
      setNewAnnotationIds(prev => {
        const next = new Set(prev);
        next.delete(annotationId);
        return next;
      });
    }, 6000);
  }, []);

  return (
    <DocumentAnnotationsContext.Provider
      value={{
        newAnnotationIds,
        addHighlight,
        addReference,
        addAssessment,
        deleteAnnotation,
        convertHighlightToReference,
        convertReferenceToHighlight,
        clearNewAnnotationId,
        triggerSparkleAnimation,
      }}
    >
      {children}
    </DocumentAnnotationsContext.Provider>
  );
}

export function useDocumentAnnotations() {
  const context = useContext(DocumentAnnotationsContext);
  if (!context) {
    throw new Error('useDocumentAnnotations must be used within DocumentAnnotationsProvider');
  }
  return context;
}
