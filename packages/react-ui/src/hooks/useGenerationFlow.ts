/**
 * useGenerationFlow - Document generation flow hook
 *
 * Manages document generation state:
 * - Generation progress tracking (from useGenerationProgress hook)
 * - Generation modal state
 * - Reference search modal state
 * - Generation completion/error handling
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useCallback } from 'react';
import type { GenerationContext, AnnotationUri } from '@semiont/api-client';
import { annotationUri } from '@semiont/api-client';
import { useGenerationProgress } from './useGenerationProgress';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useEventBus } from '../contexts/EventBusContext';

export interface GenerationFlowState {
  generationProgress: any | null;
  generationModalOpen: boolean;
  generationReferenceId: string | null;
  generationDefaultTitle: string;
  searchModalOpen: boolean;
  pendingReferenceId: string | null;
  onGenerateDocument: (referenceId: string, options: {
    title: string;
    prompt?: string;
    language?: string;
    temperature?: number;
    maxTokens?: number;
    context?: GenerationContext;
  }) => void;
  onCloseGenerationModal: () => void;
  onCloseSearchModal: () => void;
}

/**
 * Hook for document generation flow
 *
 * @param locale - Current locale for language defaults
 * @param resourceId - Resource ID for generation
 * @param showSuccess - Success toast callback
 * @param showError - Error toast callback
 * @param cacheManager - Cache manager for invalidation
 * @param clearNewAnnotationId - Clear animation callback
 * @returns Generation flow state
 */
export function useGenerationFlow(
  locale: string,
  resourceId: string,
  showSuccess: (message: string) => void,
  showError: (message: string) => void,
  cacheManager: any,
  clearNewAnnotationId: (annotationId: AnnotationUri) => void
): GenerationFlowState {
  const eventBus = useEventBus();

  // Generation progress state (from hook)
  const {
    progress: generationProgress,
    clearProgress
  } = useGenerationProgress();

  // Modal state
  const [generationModalOpen, setGenerationModalOpen] = useState(false);
  const [generationReferenceId, setGenerationReferenceId] = useState<string | null>(null);
  const [generationDefaultTitle, setGenerationDefaultTitle] = useState('');

  // Search modal state
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [pendingReferenceId, setPendingReferenceId] = useState<string | null>(null);

  // Handle document generation
  const handleGenerateDocument = useCallback((
    referenceId: string,
    options: {
      title: string;
      prompt?: string;
      language?: string;
      temperature?: number;
      maxTokens?: number;
      context?: GenerationContext;
    }
  ) => {
    // Only open modal if this is the initial click (no context provided)
    if (!options.context) {
      setGenerationReferenceId(referenceId);
      setGenerationDefaultTitle(options.title);
      setGenerationModalOpen(true);
      return;
    }

    // Modal submitted with full options - emit event for useEventOperations
    // Clear CSS sparkle animation if reference was recently created
    clearNewAnnotationId(annotationUri(referenceId));

    // Use full resource URI (W3C Web Annotation spec requires URIs)
    const resourceUriStr = `resource://${resourceId}`;

    // Emit generation:start event instead of calling SSE directly
    eventBus.emit('generation:start', {
      annotationUri: referenceId,
      resourceUri: resourceUriStr,
      options: {
        ...options,
        // Use language from modal if provided, otherwise fall back to current locale
        language: options.language || locale,
        context: options.context // Now guaranteed to exist
      }
    });
  }, [resourceId, clearNewAnnotationId, locale]); // eventBus is stable singleton - never in deps

  const handleCloseGenerationModal = useCallback(() => {
    setGenerationModalOpen(false);
  }, []);

  const handleCloseSearchModal = useCallback(() => {
    setSearchModalOpen(false);
  }, []);

  // Subscribe to generation events
  useEventSubscriptions({
    'generation:modal-open': ({ annotationUri: annUri, defaultTitle }: {
      annotationUri: string;
      resourceUri: string;
      defaultTitle: string;
    }) => {
      setGenerationReferenceId(annUri);
      setGenerationDefaultTitle(defaultTitle);
      setGenerationModalOpen(true);
    },
    'generation:complete': ({ progress }: { annotationUri: string; progress: any }) => {
      // Show success notification
      if (progress.resourceName) {
        showSuccess(`Resource "${progress.resourceName}" created successfully!`);
      } else {
        showSuccess('Resource created successfully!');
      }

      // Refetch annotations to show the reference is now resolved
      if (cacheManager) {
        cacheManager.invalidate('annotations');
      }

      // Clear progress widget after a delay to show completion state
      setTimeout(() => clearProgress(), 2000);
    },
    'generation:failed': ({ error }: { error: Error }) => {
      showError(`Resource generation failed: ${error.message}`);
    },
    'reference:search-modal-open': ({ referenceId }: { referenceId: string }) => {
      setPendingReferenceId(referenceId);
      setSearchModalOpen(true);
    },
  });

  return {
    generationProgress,
    generationModalOpen,
    generationReferenceId,
    generationDefaultTitle,
    searchModalOpen,
    pendingReferenceId,
    onGenerateDocument: handleGenerateDocument,
    onCloseGenerationModal: handleCloseGenerationModal,
    onCloseSearchModal: handleCloseSearchModal,
  };
}
