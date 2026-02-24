/**
 * ResourceViewerPage - Self-contained resource viewer component
 *
 * Handles all data loading, event subscriptions, and side effects internally.
 * Only requires minimal props from the framework layer (routing, modals).
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { components, ResourceUri, ResourceEvent } from '@semiont/core';
import { resourceAnnotationUri } from '@semiont/core';
import { getLanguage, getPrimaryRepresentation, getPrimaryMediaType } from '@semiont/api-client';
import { uriToAnnotationId } from '@semiont/core';
import { ANNOTATORS } from '@semiont/react-ui';
import { ErrorBoundary } from '@semiont/react-ui';
import { AnnotationHistory } from '@semiont/react-ui';
import { UnifiedAnnotationsPanel } from '@semiont/react-ui';
import { ResourceInfoPanel } from '@semiont/react-ui';
import { CollaborationPanel } from '@semiont/react-ui';
import { JsonLdPanel } from '@semiont/react-ui';
import { Toolbar } from '@semiont/react-ui';
import { useResourceLoadingAnnouncements } from '@semiont/react-ui';
import type { GenerationOptions } from '@semiont/react-ui';
import { ResourceViewer } from '@semiont/react-ui';
import { QUERY_KEYS } from '../../../lib/query-keys';
import { useResources, useEntityTypes } from '../../../lib/api-hooks';
import { useResourceContent } from '../../../hooks/useResourceContent';
import { useToast } from '../../../components/Toast';
import { useTheme } from '../../../contexts/ThemeContext';
import { useLineNumbers } from '../../../hooks/useLineNumbers';
import { useResourceEvents } from '../../../hooks/useResourceEvents';
import { useDebouncedCallback } from '../../../hooks/useDebounce';
import { useOpenResources } from '../../../contexts/OpenResourcesContext';
// Import EventBus hooks directly from context to avoid mocking issues in tests
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import { useResourceAnnotations } from '../../../contexts/ResourceAnnotationsContext';
import { useApiClient } from '../../../contexts/ApiClientContext';
import { useResolutionFlow } from '../../../hooks/useResolutionFlow';
import { useAnnotationFlow } from '../../../hooks/useAnnotationFlow';
import { useAttentionFlow } from '../../../hooks/useAttentionFlow';
import { usePanelNavigation } from '../../../hooks/usePanelNavigation';
import { useGenerationFlow } from '../../../hooks/useGenerationFlow';
import { useContextRetrievalFlow } from '../../../hooks/useContextRetrievalFlow';

type SemiontResource = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

export interface ResourceViewerPageProps {
  /**
   * The resource to display
   */
  resource: SemiontResource;

  /**
   * Resource URI
   */
  rUri: ResourceUri;

  /**
   * Current locale
   */
  locale: string;

  /**
   * Link component for routing
   */
  Link: React.ComponentType<any>;

  /**
   * Routes configuration
   */
  routes: any;

  /**
   * Component dependencies - passed from framework layer
   */
  ToolbarPanels: React.ComponentType<any>;
  SearchResourcesModal: React.ComponentType<any>;
  GenerationConfigModal: React.ComponentType<any>;

  /**
   * Callback to refetch document from parent
   */
  refetchDocument: () => Promise<unknown>;
}

/**
 * ResourceViewerPage - Main component
 *
 * Uses hooks directly (NO containers, NO render props, NO ResourceViewerPageContent wrapper)
 *
 * @emits navigation:router-push - Navigate to a resource or filtered view
 * @emits attend:sparkle - Trigger sparkle animation on an annotation
 * @emits resolve:update-body - Update annotation body content
 * @subscribes resource:archive - Archive the current resource
 * @subscribes resource:unarchive - Unarchive the current resource
 * @subscribes generate:clone - Clone the current resource
 * @subscribes attend:sparkle - Trigger sparkle animation
 * @subscribes annotate:added - Annotation was created
 * @subscribes annotate:removed - Annotation was deleted
 * @subscribes annotate:create-failed - Annotation creation failed
 * @subscribes annotate:delete-failed - Annotation deletion failed
 * @subscribes annotate:body-updated - Annotation body was updated
 * @subscribes annotate:body-update-failed - Annotation body update failed
 * @subscribes settings:theme-changed - UI theme changed
 * @subscribes settings:line-numbers-toggled - Line numbers display toggled
 * @subscribes detection:complete - Detection completed
 * @subscribes detection:failed - Detection failed
 * @subscribes generation:complete - Generation completed
 * @subscribes generation:failed - Generation failed
 * @subscribes navigation:reference-navigate - Navigate to a referenced document
 * @subscribes navigation:entity-type-clicked - Navigate filtered by entity type
 */
export function ResourceViewerPage({
  resource,
  rUri,
  locale,
  Link,
  routes,
  ToolbarPanels,
  SearchResourcesModal,
  GenerationConfigModal,
  refetchDocument,
}: ResourceViewerPageProps) {
  // Get unified event bus for subscribing to UI events
  const eventBus = useEventBus();
  const client = useApiClient();
  const queryClient = useQueryClient();

  // UI state hooks
  const { showError, showSuccess } = useToast();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();
  const { addResource } = useOpenResources();
  const { triggerSparkleAnimation, clearNewAnnotationId } = useResourceAnnotations();

  // API hooks
  const resources = useResources();
  const entityTypesAPI = useEntityTypes();

  // Load all data
  const { content, loading: contentLoading } = useResourceContent(rUri, resource);

  const { data: annotationsData } = resources.annotations.useQuery(rUri);
  const annotations = useMemo(
    () => annotationsData?.annotations || [],
    [annotationsData?.annotations]
  );

  const { data: referencedByData, isLoading: referencedByLoading } = resources.referencedBy.useQuery(rUri);
  const referencedBy = referencedByData?.referencedBy || [];

  const { data: entityTypesData } = entityTypesAPI.list.useQuery();
  const allEntityTypes = (entityTypesData as { entityTypes: string[] } | undefined)?.entityTypes || [];

  // Flow state hooks (NO CONTAINERS)
  const { hoveredAnnotationId } = useAttentionFlow();
  const { assistingMotivation, progress, pendingAnnotation } = useAnnotationFlow(rUri);
  const { activePanel, scrollToAnnotationId, panelInitialTab, onScrollCompleted } = usePanelNavigation();
  const { searchModalOpen, pendingReferenceId, onCloseSearchModal } = useResolutionFlow(rUri);
  const {
    generationProgress,
    generationModalOpen,
    generationReferenceId,
    generationDefaultTitle,
    onGenerateDocument,
    onCloseGenerationModal,
  } = useGenerationFlow(locale, rUri.split('/').pop() || '', clearNewAnnotationId);
  const { retrievalContext, retrievalLoading, retrievalError } = useContextRetrievalFlow(eventBus, { client, resourceUri: rUri });

  // Debounced invalidation for real-time events
  const debouncedInvalidateAnnotations = useDebouncedCallback(
    () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.annotations(rUri) });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(rUri) });
    },
    500
  );

  // Add resource to open tabs when it loads
  useEffect(() => {
    if (resource && rUri) {
      const resourceIdSegment = rUri.split('/').pop() || '';
      const mediaType = getPrimaryMediaType(resource);
      addResource(resourceIdSegment, resource.name, mediaType || undefined);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lastViewedDocumentId', resourceIdSegment);
      }
    }
  }, [resource, rUri, addResource]);

  // Real-time document events (SSE)
  useResourceEvents({
    rUri,
    autoConnect: true,

    // Annotation events - use debounced invalidation to batch rapid updates
    onAnnotationAdded: useCallback((_event: any) => {
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    onAnnotationRemoved: useCallback((_event: any) => {
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    onAnnotationBodyUpdated: useCallback((event: any) => {
      // Optimistically update annotations cache with body operations
      queryClient.setQueryData(QUERY_KEYS.resources.annotations(rUri), (old: any) => {
        if (!old) return old;
        return {
          ...old,
          annotations: old.annotations.map((annotation: any) => {
            const annotationIdSegment = uriToAnnotationId(annotation.id);
            if (annotationIdSegment === event.payload.annotationId) {
              let bodyArray = Array.isArray(annotation.body) ? [...annotation.body] : [];

              for (const op of event.payload.operations || []) {
                if (op.op === 'add') {
                  bodyArray.push(op.item);
                } else if (op.op === 'remove') {
                  bodyArray = bodyArray.filter((item: any) =>
                    JSON.stringify(item) !== JSON.stringify(op.item)
                  );
                } else if (op.op === 'replace') {
                  const index = bodyArray.findIndex((item: any) =>
                    JSON.stringify(item) === JSON.stringify(op.oldItem)
                  );
                  if (index !== -1) {
                    bodyArray[index] = op.newItem;
                  }
                }
              }

              return {
                ...annotation,
                body: bodyArray,
              };
            }
            return annotation;
          }),
        };
      });

      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(rUri) });
    }, [queryClient, rUri]),

    // Document status events
    onDocumentArchived: useCallback((_event: any) => {
      refetchDocument();
      showSuccess('This document has been archived');
      debouncedInvalidateAnnotations();
    }, [refetchDocument, showSuccess, debouncedInvalidateAnnotations]),

    onDocumentUnarchived: useCallback((_event: any) => {
      refetchDocument();
      showSuccess('This document has been unarchived');
      debouncedInvalidateAnnotations();
    }, [refetchDocument, showSuccess, debouncedInvalidateAnnotations]),

    // Entity tag events
    onEntityTagAdded: useCallback((_event: any) => {
      refetchDocument();
      debouncedInvalidateAnnotations();
    }, [refetchDocument, debouncedInvalidateAnnotations]),

    onEntityTagRemoved: useCallback((_event: any) => {
      refetchDocument();
      debouncedInvalidateAnnotations();
    }, [refetchDocument, debouncedInvalidateAnnotations]),

    onError: useCallback((error: any) => {
      console.error('[RealTime] Event stream error:', error);
    }, []),
  });

  // Mutations hoisted to top level — hooks must not be called inside callbacks
  const updateMutation = resources.update.useMutation();
  const generateCloneTokenMutation = resources.generateCloneToken.useMutation();

  // Event handlers extracted to useCallback (tenet: no inline handlers in useEventSubscriptions)
  const handleResourceArchive = useCallback(async () => {
    try {
      await updateMutation.mutateAsync({ rUri, data: { archived: true } });
      await refetchDocument();
    } catch (err) {
      console.error('Failed to archive document:', err);
      showError('Failed to archive document');
    }
  }, [updateMutation, rUri, refetchDocument, showError]);

  const handleResourceUnarchive = useCallback(async () => {
    try {
      await updateMutation.mutateAsync({ rUri, data: { archived: false } });
      await refetchDocument();
    } catch (err) {
      console.error('Failed to unarchive document:', err);
      showError('Failed to unarchive document');
    }
  }, [updateMutation, rUri, refetchDocument, showError]);

  const handleResourceClone = useCallback(async () => {
    try {
      const result = await generateCloneTokenMutation.mutateAsync(rUri);
      const token = result.token;
      eventBus.get('navigation:router-push').next({ path: `/know/compose?mode=clone&token=${token}`, reason: 'clone' });
    } catch (err) {
      console.error('Failed to generate clone token:', err);
      showError('Failed to generate clone link');
    }
  }, [generateCloneTokenMutation, rUri, showError]);

  const handleAnnotationSparkle = useCallback(({ annotationId }: { annotationId: string }) => {
    triggerSparkleAnimation(annotationId);
  }, [triggerSparkleAnimation]);

  const handleAnnotationAdded = useCallback((event: Extract<ResourceEvent, { type: 'annotation.added' }>) => {
    triggerSparkleAnimation(event.payload.annotation.id);
    debouncedInvalidateAnnotations();
  }, [triggerSparkleAnimation, debouncedInvalidateAnnotations]);

  const handleAnnotationCreateFailed = useCallback(() => showError('Failed to create annotation'), [showError]);
  const handleAnnotationDeleteFailed = useCallback(() => showError('Failed to delete annotation'), [showError]);
  const handleAnnotateBodyUpdated = useCallback(() => {
    // Success - optimistic update already applied via useResourceEvents
  }, []);
  const handleAnnotateBodyUpdateFailed = useCallback(() => showError('Failed to update annotation'), [showError]);

  const handleSettingsThemeChanged = useCallback(({ theme }: { theme: any }) => setTheme(theme), [setTheme]);

  const handleDetectionComplete = useCallback(() => {
    // Toast notification is handled by useAnnotationFlow
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.annotations(rUri) });
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(rUri) });
  }, [queryClient, rUri]);
  const handleDetectionFailed = useCallback(() => {
    // Error notification is handled by useAnnotationFlow
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.annotations(rUri) });
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(rUri) });
  }, [queryClient, rUri]);
  const handleGenerationComplete = useCallback(() => {
    // Toast notification is handled by useGenerationFlow
  }, []);
  const handleGenerationFailed = useCallback(() => {
    // Error notification is handled by useGenerationFlow
  }, []);

  const handleReferenceNavigate = useCallback(({ documentId }: { documentId: string }) => {
    if (routes.resource) {
      const path = routes.resource.replace('[resourceId]', encodeURIComponent(documentId));
      eventBus.get('navigation:router-push').next({ path, reason: 'reference-link' });
    }
  }, [routes.resource]); // eventBus is stable singleton - never in deps

  const handleEntityTypeClicked = useCallback(({ entityType }: { entityType: string }) => {
    if (routes.know) {
      const path = `${routes.know}?entityType=${encodeURIComponent(entityType)}`;
      eventBus.get('navigation:router-push').next({ path, reason: 'entity-type-filter' });
    }
  }, [routes.know]); // eventBus is stable singleton - never in deps

  // Event bus subscriptions (combined into single useEventSubscriptions call to prevent hook ordering issues)
  useEventSubscriptions({
    'resource:archive': handleResourceArchive,
    'resource:unarchive': handleResourceUnarchive,
    'generate:clone': handleResourceClone,
    'attend:sparkle': handleAnnotationSparkle,
    'annotate:added': handleAnnotationAdded,
    'annotate:removed': debouncedInvalidateAnnotations,
    'annotate:create-failed': handleAnnotationCreateFailed,
    'annotate:delete-failed': handleAnnotationDeleteFailed,
    'annotate:body-updated': handleAnnotateBodyUpdated,
    'resolve:body-update-failed': handleAnnotateBodyUpdateFailed,
    'settings:theme-changed': handleSettingsThemeChanged,
    'settings:line-numbers-toggled': toggleLineNumbers,
    'annotate:detect-finished': handleDetectionComplete,
    'annotate:detect-failed': handleDetectionFailed,
    'generate:finished': handleGenerationComplete,
    'generate:failed': handleGenerationFailed,
    'navigation:reference-navigate': handleReferenceNavigate,
    'navigation:entity-type-clicked': handleEntityTypeClicked,
  });

  // Resource loading announcements
  const {
    announceResourceLoading,
    announceResourceLoaded
  } = useResourceLoadingAnnouncements();

  // Announce content loading state changes (app-level)
  useEffect(() => {
    if (contentLoading) {
      announceResourceLoading(resource.name);
    } else if (content) {
      announceResourceLoaded(resource.name);
    }
  }, [contentLoading, content, resource.name, announceResourceLoading, announceResourceLoaded]);

  // Derived state
  const documentEntityTypes = resource.entityTypes || [];

  // Get primary representation metadata
  const primaryRep = getPrimaryRepresentation(resource);
  const primaryMediaType = primaryRep?.mediaType;
  const primaryByteSize = primaryRep?.byteSize;

  // Annotate mode state - local UI state only
  const [annotateMode, _setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });

  // Group annotations by type using static ANNOTATORS
  const result = {
    highlights: [] as Annotation[],
    references: [] as Annotation[],
    assessments: [] as Annotation[],
    comments: [] as Annotation[],
    tags: [] as Annotation[]
  };

  for (const ann of annotations) {
    const annotator = Object.values(ANNOTATORS).find(a => a.matchesAnnotation(ann));
    if (annotator) {
      const key = annotator.internalType + 's'; // highlight -> highlights
      if (result[key as keyof typeof result]) {
        result[key as keyof typeof result].push(ann);
      }
    }
  }

  const groups = result;

  // Combine resource with content
  const resourceWithContent = { ...resource, content };

  // Handlers for AnnotationHistory (legacy event-based interaction)
  const handleEventHover = useCallback((annotationId: string | null) => {
    if (annotationId) {
      eventBus.get('attend:sparkle').next({ annotationId });
    }
  }, []); // eventBus is stable singleton - never in deps

  const handleEventClick = useCallback((_annotationId: string | null) => {
    // ResourceViewer now manages scroll state internally
  }, []);

  // Document rendering
  return (
    <div className={`semiont-document-viewer${activePanel ? ' semiont-document-viewer--panel-open' : ''}`}>
      {/* Main Content - Fills remaining height */}
      <div className="semiont-document-viewer__main">
        {/* Document Content - Left Side */}
        <div className="semiont-document-viewer__content">
          {/* Document Header - Only spans document content width */}
          <div className="semiont-document-viewer__header">
            <div className="semiont-document-viewer__header-inner">
              <h2 className="semiont-document-viewer__title">
                {resource.name}
              </h2>
            </div>
          </div>
          {/* Scrollable body wrapper - contains document content, header is sibling above */}
          <div className="semiont-document-viewer__scrollable-body" lang={getLanguage(resource) || undefined}>
            <ErrorBoundary
              fallback={(error, reset) => (
                <div className="semiont-document-viewer__error">
                  <h3 className="semiont-document-viewer__error-title">
                    Error loading document viewer
                  </h3>
                  <p className="semiont-document-viewer__error-message">
                    {error.message}
                  </p>
                  <button
                    onClick={reset}
                    className="semiont-document-viewer__error-button"
                  >
                    Try again
                  </button>
                </div>
              )}
            >
              {contentLoading ? (
                <div className="semiont-document-viewer__loading">
                  Loading document content...
                </div>
              ) : (
                <ResourceViewer
                  resource={resourceWithContent}
                  annotations={groups}
                  generatingReferenceId={generationProgress?.referenceId ?? null}
                  showLineNumbers={showLineNumbers}
                  hoveredAnnotationId={hoveredAnnotationId}
                />
              )}
            </ErrorBoundary>
          </div>
        </div>

        {/* Sidebar */}
        <div className="semiont-document-viewer__sidebar">
          {/* Right Panel - Conditional based on active toolbar panel */}
          <ToolbarPanels
            activePanel={activePanel}
            theme={theme}
            showLineNumbers={showLineNumbers}
            width={
              activePanel === 'jsonld' ? 'w-[600px]' :
              activePanel === 'annotations' ? 'w-[400px]' :
              'w-64'
            }
          >
            {/* Archived Status */}
            {annotateMode && resource.archived && (
              <div className="semiont-document-viewer__archived-status">
                <div className="semiont-document-viewer__archived-text">
                  📦 Archived
                </div>
              </div>
            )}

            {/* Unified Annotations Panel */}
            {activePanel === 'annotations' && !resource.archived && (
              <UnifiedAnnotationsPanel
                annotations={annotations}
                annotators={ANNOTATORS}
                annotateMode={annotateMode}
                assistingMotivation={assistingMotivation}
                progress={progress}
                pendingAnnotation={pendingAnnotation}
                allEntityTypes={allEntityTypes}
                generatingReferenceId={generationProgress?.referenceId ?? null}
                referencedBy={referencedBy}
                referencedByLoading={referencedByLoading}
                resourceId={rUri.split('/').pop() || ''}
                scrollToAnnotationId={scrollToAnnotationId}
                hoveredAnnotationId={hoveredAnnotationId}
                onScrollCompleted={onScrollCompleted}
                initialTab={panelInitialTab?.tab as any}
                initialTabGeneration={panelInitialTab?.generation}
                Link={Link}
                routes={routes}
              />
            )}

            {/* History Panel */}
            {activePanel === 'history' && (
              <AnnotationHistory
                rUri={rUri}
                hoveredAnnotationId={hoveredAnnotationId}
                onEventHover={handleEventHover}
                onEventClick={handleEventClick}
                Link={Link}
                routes={routes}
              />
            )}

            {/* Document Info Panel */}
            {activePanel === 'info' && (
              <ResourceInfoPanel
                documentEntityTypes={documentEntityTypes}
                documentLocale={getLanguage(resource)}
                primaryMediaType={primaryMediaType}
                primaryByteSize={primaryByteSize}
                isArchived={resource.archived ?? false}
              />
            )}

            {/* Collaboration Panel */}
            {activePanel === 'collaboration' && (
              <CollaborationPanel
                isConnected={false}
                eventCount={0}
              />
            )}

            {/* JSON-LD Panel */}
            {activePanel === 'jsonld' && (
              <JsonLdPanel resource={resource} />
            )}
          </ToolbarPanels>

          {/* Toolbar - Always visible on the right */}
          <Toolbar
            context="document"
            activePanel={activePanel}
            isArchived={resource.archived ?? false}
          />
        </div>
      </div>

      {/* Search Resources Modal */}
      <SearchResourcesModal
        isOpen={searchModalOpen}
        onClose={onCloseSearchModal}
        onSelect={async (documentId: string) => {
          if (pendingReferenceId) {
            try {
              const annotationIdShort = pendingReferenceId.split('/').pop();
              if (!annotationIdShort) {
                throw new Error('Invalid reference ID');
              }

              const resourceIdSegment = rUri.split('/').pop() || '';
              const nestedUri = `${window.location.origin}/resources/${resourceIdSegment}/annotations/${annotationIdShort}`;

              eventBus.get('resolve:update-body').next({
                annotationUri: resourceAnnotationUri(nestedUri),
                resourceId: resourceIdSegment,
                operations: [{
                  op: 'add',
                  item: {
                    type: 'SpecificResource' as const,
                    source: documentId,
                    purpose: 'linking' as const,
                  },
                }],
              });
              showSuccess('Reference linked successfully');
              // Cache invalidation now handled by annotate:body-updated event
              onCloseSearchModal();
            } catch (error) {
              console.error('Failed to link reference:', error);
              showError('Failed to link reference');
            }
          }
        }}
      />

      {/* Generation Config Modal */}
      <GenerationConfigModal
        isOpen={generationModalOpen}
        onClose={onCloseGenerationModal}
        onGenerate={(options: GenerationOptions) => {
          if (generationReferenceId) {
            onGenerateDocument(generationReferenceId, options);
          }
        }}
        defaultTitle={generationDefaultTitle}
        context={retrievalContext}
        contextLoading={retrievalLoading}
        contextError={retrievalError}
      />
    </div>
  );
}
