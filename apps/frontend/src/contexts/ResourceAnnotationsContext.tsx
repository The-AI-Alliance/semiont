'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { useAnnotations } from '@/lib/api-hooks';
import type { components, AnnotationUri, ResourceUri, ResourceAnnotationUri } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, getTargetSource, getTargetSelector, resourceUri, resourceAnnotationUri } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
// Create annotation request type - narrow target to only the object form (not string)
type CreateAnnotationRequest = Omit<Annotation, 'id' | 'created' | 'modified' | 'creator' | '@context' | 'type' | 'target'> & {
  target: {
    source: string;
    selector: { type: 'TextPositionSelector'; start: number; end: number; } | { type: 'TextQuoteSelector'; exact: string; prefix?: string; suffix?: string; } | ({ type: 'TextPositionSelector'; start: number; end: number; } | { type: 'TextQuoteSelector'; exact: string; prefix?: string; suffix?: string; })[];
  };
} & Partial<Pick<Annotation, '@context' | 'type'>>;

export interface SelectionData {
  exact: string;
  start: number;
  end: number;
}

interface ResourceAnnotationsContextType {
  // UI state only - data comes from React Query hooks in components
  newAnnotationIds: Set<string>; // Track recently created annotations for sparkle animations

  // Mutation actions (still in context for consistency)
  addHighlight: (rUri: ResourceUri, exact: string, position: { start: number; end: number }) => Promise<string | undefined>;
  addReference: (rUri: ResourceUri, exact: string, position: { start: number; end: number }, targetDocId?: string, entityType?: string, referenceType?: string) => Promise<string | undefined>;
  addAssessment: (rUri: ResourceUri, exact: string, position: { start: number; end: number }) => Promise<string | undefined>;
  addComment: (rUri: ResourceUri, selection: SelectionData, commentText: string) => Promise<string | undefined>;
  deleteAnnotation: (annotationId: string, rUri: ResourceUri) => Promise<void>;
  convertHighlightToReference: (highlights: Annotation[], highlightId: string, targetDocId?: string, entityType?: string, referenceType?: string) => Promise<void>;
  convertReferenceToHighlight: (references: Annotation[], referenceId: string) => Promise<void>;

  // UI actions
  clearNewAnnotationId: (id: AnnotationUri) => void;
  triggerSparkleAnimation: (annotationId: string) => void;
}

const ResourceAnnotationsContext = createContext<ResourceAnnotationsContextType | undefined>(undefined);

export function ResourceAnnotationsProvider({ children }: { children: React.ReactNode }) {
  // UI state only - no data management
  const [newAnnotationIds, setNewAnnotationIds] = useState<Set<string>>(new Set());

  // API hooks
  const annotations = useAnnotations();

  // Set up mutation hooks
  const createAnnotationMutation = annotations.create.useMutation();
  const deleteAnnotationMutation = annotations.delete.useMutation();

  const addHighlight = useCallback(async (
    rUri: ResourceUri,
    exact: string,
    position: { start: number; end: number }
  ): Promise<string | undefined> => {
    try {
      const createData: CreateAnnotationRequest = {
        motivation: 'highlighting',
        target: {
          source: rUri,
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
        body: [],
      };

      const result = await createAnnotationMutation.mutateAsync({
        rUri,
        data: createData
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
  }, [createAnnotationMutation]);

  const addReference = useCallback(async (
    rUri: ResourceUri,
    exact: string,
    position: { start: number; end: number },
    targetDocId?: string,
    entityType?: string,
    referenceType?: string
  ): Promise<string | undefined> => {
    try {
      // Build CreateAnnotationRequest following W3C Web Annotation format
      // Backend expects source as a full URI
      const createData: CreateAnnotationRequest = {
        motivation: 'linking',
        target: {
          source: rUri,
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
      const result = await createAnnotationMutation.mutateAsync({
        rUri,
        data: createData
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
      console.error('Failed to create reference:', err);
      throw err;
    }
  }, [createAnnotationMutation]);

  const addAssessment = useCallback(async (
    rUri: ResourceUri,
    exact: string,
    position: { start: number; end: number }
  ): Promise<string | undefined> => {
    try {
      // Build CreateAnnotationRequest following W3C Web Annotation format
      // Assessment uses motivation: 'assessing'
      // Backend expects source as a full URI
      const createData: CreateAnnotationRequest = {
        motivation: 'assessing',  // W3C motivation for assessments
        target: {
          source: rUri,
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
      const result = await createAnnotationMutation.mutateAsync({
        rUri,
        data: createData
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
      console.error('Failed to create assessment:', err);
      throw err;
    }
  }, [createAnnotationMutation]);

  const addComment = useCallback(async (
    rUri: ResourceUri,
    selection: SelectionData,
    commentText: string
  ): Promise<string | undefined> => {
    try {
      // Build CreateAnnotationRequest following W3C Web Annotation format
      // Comment uses motivation: 'commenting'
      // Backend expects source as a full URI
      const createData: CreateAnnotationRequest = {
        motivation: 'commenting',  // W3C motivation for comments
        target: {
          source: rUri,
          selector: [
            {
              type: 'TextPositionSelector',
              start: selection.start,
              end: selection.end,
            },
            {
              type: 'TextQuoteSelector',
              exact: selection.exact,
            },
          ],
        },
        // Comment body with TextualBody structure
        body: {
          type: 'TextualBody',
          value: commentText,
          format: 'text/plain',
          purpose: 'commenting',
        },
      };

      // Create the annotation
      const result = await createAnnotationMutation.mutateAsync({
        rUri,
        data: createData
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
      console.error('Failed to create comment:', err);
      throw err;
    }
  }, [createAnnotationMutation]);

  const deleteAnnotation = useCallback(async (annotationId: string, rUri: ResourceUri) => {
    try {
      await deleteAnnotationMutation.mutateAsync(
        resourceAnnotationUri(`${rUri}/annotations/${annotationId}`)
      );
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
      if (!targetSource) {
        throw new Error('Highlight has no target source');
      }
      await deleteAnnotationMutation.mutateAsync(
        resourceAnnotationUri(`${targetSource}/annotations/${highlightId}`)
      );

      // Create new reference with same position
      const targetSelector = getTargetSelector(highlight.target);
      const posSelector = getTextPositionSelector(targetSelector);
      if (!posSelector) {
        throw new Error('Cannot convert highlight to reference: TextPositionSelector required');
      }
      await addReference(
        resourceUri(targetSource),
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
      if (!targetSource) {
        throw new Error('Reference has no target source');
      }
      await deleteAnnotationMutation.mutateAsync(
        resourceAnnotationUri(`${targetSource}/annotations/${referenceId}`)
      );

      // Create new highlight with same position
      const targetSelector = getTargetSelector(reference.target);
      const posSelector = getTextPositionSelector(targetSelector);
      if (!posSelector) {
        throw new Error('Cannot convert reference to highlight: TextPositionSelector required');
      }
      await addHighlight(
        resourceUri(targetSource),
        getExactText(targetSelector),
        { start: posSelector.start, end: posSelector.end }
      );
    } catch (err) {
      console.error('Failed to convert reference to highlight:', err);
      throw err;
    }
  }, [addHighlight, deleteAnnotationMutation]);

  const clearNewAnnotationId = useCallback((id: AnnotationUri) => {
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
        addComment,
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
