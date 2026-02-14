/**
 * GenerationFlowContainer - Manages document generation flow
 *
 * This container handles:
 * - Generation progress state (from useGenerationProgress hook)
 * - Generation modal state
 * - Reference search modal state
 * - Generation completion/error events
 *
 * By extracting this container:
 * 1. Generation logic is testable in isolation
 * 2. Separates generation state from UI
 * 3. Clear event → state flow
 */

import { useState, useCallback } from 'react';
import type { ResourceUri, GenerationContext, AnnotationUri } from '@semiont/api-client';
import { annotationUri, resourceUri } from '@semiont/api-client';
import { useGenerationProgress } from '../../../hooks/useGenerationProgress';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';

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

export interface GenerationFlowContainerProps {
  rUri: ResourceUri;
  locale: string;
  resourceId: string;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
  cacheManager: any;
  clearNewAnnotationId: (annotationId: AnnotationUri) => void;
  children: (state: GenerationFlowState) => React.ReactNode;
}

/**
 * Container for document generation flow
 *
 * Usage:
 * ```tsx
 * <GenerationFlowContainer {...props}>
 *   {({ generationProgress, onGenerateDocument, ... }) => (
 *     <ReferencesPanel
 *       generatingReferenceId={generationProgress?.referenceId}
 *       onGenerateDocument={onGenerateDocument}
 *     />
 *   )}
 * </GenerationFlowContainer>
 * ```
 */
export function GenerationFlowContainer({
  locale,
  resourceId,
  showSuccess,
  showError,
  cacheManager,
  clearNewAnnotationId,
  children,
}: GenerationFlowContainerProps) {

  // Generation progress state (from hook)
  const {
    progress: generationProgress,
    startGeneration,
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

    // Modal submitted with full options - proceed with generation
    // Clear CSS sparkle animation if reference was recently created
    clearNewAnnotationId(annotationUri(referenceId));

    // Use full resource URI (W3C Web Annotation spec requires URIs)
    const resourceUriStr = `resource://${resourceId}`;
    startGeneration(annotationUri(referenceId), resourceUri(resourceUriStr), {
      ...options,
      // Use language from modal if provided, otherwise fall back to current locale
      language: options.language || locale,
      context: options.context
    });
  }, [startGeneration, resourceId, clearNewAnnotationId, locale]);

  // Event handlers extracted from useEventSubscriptions
  const handleGenerationComplete = useCallback(({ progress }: { progress: any }) => {
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
  }, [showSuccess, cacheManager, clearProgress]);

  const handleGenerationError = useCallback(({ error }: { error: string }) => {
    showError(`Resource generation failed: ${error}`);
  }, [showError]);

  const handleSearchModalOpen = useCallback(({ referenceId }: { referenceId: string }) => {
    setPendingReferenceId(referenceId);
    setSearchModalOpen(true);
  }, []);

  const handleCloseGenerationModal = useCallback(() => {
    setGenerationModalOpen(false);
  }, []);

  const handleCloseSearchModal = useCallback(() => {
    setSearchModalOpen(false);
  }, []);

  // Subscribe to generation events
  useEventSubscriptions({
    'generation:complete-event': handleGenerationComplete,
    'generation:error-event': handleGenerationError,
    'reference:search-modal-open': handleSearchModalOpen,
  });

  return <>{children({
    generationProgress,
    generationModalOpen,
    generationReferenceId,
    generationDefaultTitle,
    searchModalOpen,
    pendingReferenceId,
    onGenerateDocument: handleGenerateDocument,
    onCloseGenerationModal: handleCloseGenerationModal,
    onCloseSearchModal: handleCloseSearchModal,
  })}</>;
}
