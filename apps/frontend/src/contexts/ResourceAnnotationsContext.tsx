'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { annotations } from '@/lib/api/annotations';
import { useAuthenticatedAPI } from '@/hooks/useAuthenticatedAPI';
import type { components, paths } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, getTargetSource, getTargetSelector } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;
type CreateAnnotationRequest = RequestContent<paths['/api/annotations']['post']>;

interface ResourceAnnotationsContextType {
  // UI state only - data comes from React Query hooks in components
  newAnnotationIds: Set<string>; // Track recently created annotations for sparkle animations

  // Mutation actions (still in context for consistency)
  addHighlight: (resourceId: string, exact: string, position: { start: number; end: number }) => Promise<string | undefined>;
  addReference: (resourceId: string, exact: string, position: { start: number; end: number }, targetDocId?: string, entityType?: string, referenceType?: string) => Promise<string | undefined>;
  addAssessment: (resourceId: string, exact: string, position: { start: number; end: number }) => Promise<string | undefined>;
  deleteAnnotation: (annotationId: string, resourceId: string) => Promise<void>;
  convertHighlightToReference: (highlights: Annotation[], highlightId: string, targetDocId?: string, entityType?: string, referenceType?: string) => Promise<void>;
  convertReferenceToHighlight: (references: Annotation[], referenceId: string) => Promise<void>;

  // UI actions
  clearNewAnnotationId: (id: string) => void;
  triggerSparkleAnimation: (annotationId: string) => void;
}

const ResourceAnnotationsContext = createContext<ResourceAnnotationsContextType | undefined>(undefined);

export function ResourceAnnotationsProvider({ children }: { children: React.ReactNode }) {
  // UI state only - no data management
  const [newAnnotationIds, setNewAnnotationIds] = useState<Set<string>>(new Set());

  // Set up mutation hooks
  const saveHighlightMutation = annotations.saveAsHighlight.useMutation();
  const createAnnotationMutation = annotations.create.useMutation();
  const deleteAnnotationMutation = annotations.delete.useMutation();

  const addHighlight = useCallback(async (
    resourceId: string,
    exact: string,
    position: { start: number; end: number }
  ): Promise<string | undefined> => {
    try {
      const result = await saveHighlightMutation.mutateAsync({
        resourceId,
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
    resourceId: string,
    exact: string,
    position: { start: number; end: number },
    targetDocId?: string,
    entityType?: string,
    referenceType?: string
  ): Promise<string | undefined> => {
    try {
      // Build CreateAnnotationRequest following W3C Web Annotation format
      // Backend expects source as a full URI
      const resourceUri = `${process.env.NEXT_PUBLIC_API_URL}/resources/${resourceId}`;
      const createData: CreateAnnotationRequest = {
        motivation: 'linking',
        target: {
          source: resourceUri,
          selector: [
            {
              type: 'TextPositionSelector',
              start: position.start,
              end: position.end,
            },
            {
              type: 'TextQuoteSelector',
              exact: exact,
            },
          ],
        },
        // Build body array with entity tag bodies + linking body (if resolved)
        body: (() => {
          const bodyArray: Array<{type: 'TextualBody'; value: string; purpose: 'tagging'} | {type: 'SpecificResource'; source: string; purpose: 'linking'}> = [];

          // Add entity tag bodies (TextualBody with purpose: "tagging")
          if (entityType) {
            const entityTypes = entityType.split(',').map((t: string) => t.trim()).filter((t: string) => t);
            for (const et of entityTypes) {
              bodyArray.push({
                type: 'TextualBody' as const,
                value: et,
                purpose: 'tagging' as const,
              });
            }
          }

          // Add linking body (SpecificResource) if resolved
          if (targetDocId) {
            bodyArray.push({
              type: 'SpecificResource' as const,
              source: targetDocId,
              purpose: 'linking' as const,
            });
          }

          return bodyArray;
        })(),
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
    resourceId: string,
    exact: string,
    position: { start: number; end: number }
  ): Promise<string | undefined> => {
    try {
      // Build CreateAnnotationRequest following W3C Web Annotation format
      // Assessment uses motivation: 'assessing'
      // Backend expects source as a full URI
      const resourceUri = `${process.env.NEXT_PUBLIC_API_URL}/resources/${resourceId}`;
      const createData: CreateAnnotationRequest = {
        motivation: 'assessing',  // W3C motivation for assessments
        target: {
          source: resourceUri,
          selector: [
            {
              type: 'TextPositionSelector',
              start: position.start,
              end: position.end,
            },
            {
              type: 'TextQuoteSelector',
              exact: exact,
            },
          ],
        },
        // Empty body array (assessments don't have bodies yet)
        body: [],
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

  const deleteAnnotation = useCallback(async (annotationId: string, resourceId: string) => {
    try {
      // Backend expects resourceId as a full URI, not just the ID
      const resourceUri = `${process.env.NEXT_PUBLIC_API_URL}/resources/${resourceId}`;
      await deleteAnnotationMutation.mutateAsync({ id: annotationId, resourceId: resourceUri });
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
      const targetSource = getTargetSource(highlight.target);
      await deleteAnnotationMutation.mutateAsync({
        id: highlightId,
        resourceId: targetSource
      });

      // Create new reference with same position
      const targetSelector = getTargetSelector(highlight.target);
      const posSelector = getTextPositionSelector(targetSelector);
      if (!posSelector) {
        throw new Error('Cannot convert highlight to reference: TextPositionSelector required');
      }
      await addReference(
        targetSource,
        getExactText(targetSelector),
        { start: posSelector.start, end: posSelector.end },
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
      const targetSource = getTargetSource(reference.target);
      await deleteAnnotationMutation.mutateAsync({
        id: referenceId,
        resourceId: targetSource
      });

      // Create new highlight with same position
      const targetSelector = getTargetSelector(reference.target);
      const posSelector = getTextPositionSelector(targetSelector);
      if (!posSelector) {
        throw new Error('Cannot convert reference to highlight: TextPositionSelector required');
      }
      await addHighlight(
        targetSource,
        getExactText(targetSelector),
        { start: posSelector.start, end: posSelector.end }
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
    <ResourceAnnotationsContext.Provider
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
    </ResourceAnnotationsContext.Provider>
  );
}

export function useResourceAnnotations() {
  const context = useContext(ResourceAnnotationsContext);
  if (!context) {
    throw new Error('useResourceAnnotations must be used within ResourceAnnotationsProvider');
  }
  return context;
}
