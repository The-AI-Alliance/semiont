/**
 * ResourceViewerPage - Pure React component for viewing resources
 *
 * No Next.js dependencies - receives all data and callbacks via props.
 * This component handles the UI rendering and state management for the resource viewer.
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { components, ResourceUri, Selector } from '@semiont/api-client';
import { getLanguage, getPrimaryRepresentation, resourceAnnotationUri } from '@semiont/api-client';
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
// Import EventBus hooks directly from context to avoid mocking issues in tests
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import { useResourceAnnotations } from '@semiont/react-ui';
import { DetectionFlowContainer } from '../containers/DetectionFlowContainer';
import { PanelNavigationContainer } from '../containers/PanelNavigationContainer';
import { AnnotationFlowContainer } from '../containers/AnnotationFlowContainer';
import { GenerationFlowContainer } from '../containers/GenerationFlowContainer';

type SemiontResource = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

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
   * Document content (already loaded)
   */
  content: string;

  /**
   * Whether content is still loading
   */
  contentLoading: boolean;

  /**
   * All annotations for this resource
   */
  annotations: Annotation[];

  /**
   * Resources that reference this resource
   */
  referencedBy: any[];

  /**
   * Whether referencedBy is loading
   */
  referencedByLoading: boolean;

  /**
   * All available entity types
   */
  allEntityTypes: string[];

  /**
   * Current locale
   */
  locale: string;


  /**
   * Theme state
   */
  theme: any;

  /**
   * Line numbers state
   */
  showLineNumbers: boolean;

  /**
   * Toast notifications
   */
  showSuccess: (message: string) => void;
  showError: (message: string) => void;

  /**
   * Cache manager for detection
   */
  cacheManager: any;

  /**
   * Link component for routing
   */
  Link: React.ComponentType<any>;

  /**
   * Routes configuration
   */
  routes: any;

  /**
   * Component dependencies - passed from frontend
   */
  ToolbarPanels: React.ComponentType<any>;
  SearchResourcesModal: React.ComponentType<any>;
  GenerationConfigModal: React.ComponentType<any>;
}

// Inner component that has access to event bus
function ResourceViewerPageInner({
  resource,
  rUri,
  content,
  contentLoading,
  annotations,
  referencedBy,
  referencedByLoading,
  allEntityTypes,
  locale,
  theme,
  showLineNumbers,
  showSuccess,
  showError,
  cacheManager,
  Link,
  routes,
  ToolbarPanels,
  SearchResourcesModal,
  GenerationConfigModal,
}: ResourceViewerPageProps) {
  // Get unified event bus for subscribing to UI events
  const eventBus = useEventBus();

  // Resource loading announcements
  const {
    announceResourceLoading,
    announceResourceLoaded
  } = useResourceLoadingAnnouncements();

  // Access annotation context
  const { clearNewAnnotationId, deleteAnnotation } = useResourceAnnotations();

  // Announce content loading state changes (app-level)
  useEffect(() => {
    if (contentLoading) {
      announceResourceLoading(resource.name);
    } else if (content) {
      announceResourceLoaded(resource.name);
    }
  }, [contentLoading, content, resource.name, announceResourceLoading, announceResourceLoaded]);

  // App-level routing events (navigation only)
  useEventSubscriptions({
    'navigation:reference-navigate': ({ documentId }: { documentId: string }) => {
      // Navigate to the referenced document
      if (routes.resource) {
        const path = routes.resource.replace('[resourceId]', encodeURIComponent(documentId));
        eventBus.emit('navigation:router-push', { path, reason: 'reference-link' });
      }
    },
    'navigation:entity-type-clicked': ({ entityType }: { entityType: string }) => {
      // Navigate to discovery page filtered by entity type
      if (routes.know) {
        const path = `${routes.know}?entityType=${encodeURIComponent(entityType)}`;
        eventBus.emit('navigation:router-push', { path, reason: 'entity-type-filter' });
      }
    },
    'detection:failed': (payload: any) => {
      const errorMessage = payload?.error?.message || payload?.message || 'Detection failed';
      showError(errorMessage);
    },
  });

  // Compose all containers with nested render props
  return (
    <DetectionFlowContainer rUri={rUri}>
      {(detectionState) => (
        <PanelNavigationContainer>
          {(navState) => (
            <AnnotationFlowContainer
              rUri={rUri}
              onDeleteAnnotation={deleteAnnotation}
            >
              {(annotationState) => (
                <GenerationFlowContainer
                  rUri={rUri}
                  locale={locale}
                  resourceId={rUri.split('/').pop() || ''}
                  showSuccess={showSuccess}
                  showError={showError}
                  cacheManager={cacheManager}
                  clearNewAnnotationId={clearNewAnnotationId}
                >
                  {(generationState) => (
                    <ResourceViewerPageContent
                      {...{
                        resource,
                        rUri,
                        content,
                        contentLoading,
                        annotations,
                        referencedBy,
                        referencedByLoading,
                        allEntityTypes,
                        locale,
                        theme,
                        showLineNumbers,
                        showSuccess,
                        showError,
                        cacheManager,
                        Link,
                        routes,
                        ToolbarPanels,
                        SearchResourcesModal,
                        GenerationConfigModal,
                      }}
                      {...detectionState}
                      {...navState}
                      {...annotationState}
                      {...generationState}
                      onDeleteAnnotation={deleteAnnotation}
                    />
                  )}
                </GenerationFlowContainer>
              )}
            </AnnotationFlowContainer>
          )}
        </PanelNavigationContainer>
      )}
    </DetectionFlowContainer>
  );
}

// Pure presentation component that receives all state as props
interface ResourceViewerPageContentProps extends ResourceViewerPageProps {
  // From DetectionFlowContainer
  detectingMotivation: Motivation | null;
  detectionProgress: any | null;
  detectionStreamRef: React.MutableRefObject<any>;

  // From PanelNavigationContainer
  activePanel: string | null;
  scrollToAnnotationId: string | null;
  panelInitialTab: { tab: string; generation: number } | null;
  onScrollCompleted: () => void;

  // From AnnotationFlowContainer
  pendingAnnotation: { selector: Selector | Selector[]; motivation: Motivation } | null;
  hoveredAnnotationId: string | null;

  // From GenerationFlowContainer
  generationProgress: any | null;
  generationModalOpen: boolean;
  generationReferenceId: string | null;
  generationDefaultTitle: string;
  searchModalOpen: boolean;
  pendingReferenceId: string | null;
  onGenerateDocument: (referenceId: string, options: any) => void;
  onCloseGenerationModal: () => void;
  onCloseSearchModal: () => void;

  // Pass-through
  onDeleteAnnotation: (annotationId: string, rUri: ResourceUri) => Promise<void>;
}

function ResourceViewerPageContent(props: ResourceViewerPageContentProps) {
  const {
    // Container state
    detectingMotivation,
    detectionProgress,
    activePanel,
    scrollToAnnotationId,
    panelInitialTab,
    onScrollCompleted,
    pendingAnnotation,
    hoveredAnnotationId,
    generationProgress,
    generationModalOpen,
    generationReferenceId,
    generationDefaultTitle,
    searchModalOpen,
    pendingReferenceId,
    onGenerateDocument,
    onCloseGenerationModal,
    onCloseSearchModal,
    // Original props
    resource,
    rUri,
    content,
    contentLoading,
    annotations,
    referencedBy,
    referencedByLoading,
    allEntityTypes,
    theme,
    showLineNumbers,
    showSuccess,
    showError,
    Link,
    routes,
    ToolbarPanels,
    SearchResourcesModal,
    GenerationConfigModal,
  } = props;

  const eventBus = useEventBus();

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
      eventBus.emit('annotation:sparkle', { annotationId });
    }
  }, [eventBus]);

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
                detectingMotivation={detectingMotivation}
                detectionProgress={detectionProgress}
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

              eventBus.emit('annotation:update-body', {
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
              // Cache invalidation now handled by annotation:updated event
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
        referenceId={generationReferenceId || ''}
        resourceUri={rUri}
        defaultTitle={generationDefaultTitle}
      />
    </div>
  );
}

// Export the component directly - provider setup is done by the app
export function ResourceViewerPage(props: ResourceViewerPageProps) {
  return <ResourceViewerPageInner {...props} />;
}
