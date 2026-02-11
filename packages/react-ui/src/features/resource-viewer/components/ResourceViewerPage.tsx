/**
 * ResourceViewerPage - Pure React component for viewing resources
 *
 * No Next.js dependencies - receives all data and callbacks via props.
 * This component handles the UI rendering and state management for the resource viewer.
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { components, ResourceUri, GenerationContext, Selector } from '@semiont/api-client';
import { getLanguage, getPrimaryRepresentation, annotationUri, resourceUri, resourceAnnotationUri } from '@semiont/api-client';
import { createCancelDetectionHandler, ANNOTATORS } from '@semiont/react-ui';
import { ErrorBoundary } from '@semiont/react-ui';
import { useGenerationProgress } from '@semiont/react-ui';
import { AnnotationHistory } from '@semiont/react-ui';
import { UnifiedAnnotationsPanel } from '@semiont/react-ui';
import { ResourceInfoPanel } from '@semiont/react-ui';
import { CollaborationPanel } from '@semiont/react-ui';
import { JsonLdPanel } from '@semiont/react-ui';
import { Toolbar } from '@semiont/react-ui';
import { useResourceLoadingAnnouncements } from '@semiont/react-ui';
import type { GenerationOptions } from '@semiont/react-ui';
import { ResourceViewer } from '@semiont/react-ui';
import { useEvents } from '@semiont/react-ui';
import { useEventSubscriptions } from '@semiont/react-ui';
import { useResourceAnnotations } from '@semiont/react-ui';

type SemiontResource = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

// Unified pending annotation type - all human-created annotations flow through this
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

import type { DetectionProgress } from '@semiont/react-ui';

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
  const eventBus = useEvents();
  // Resource loading announcements
  const {
    announceResourceLoading,
    announceResourceLoaded
  } = useResourceLoadingAnnouncements();

  // Access annotation context
  const { clearNewAnnotationId } = useResourceAnnotations();

  // Derived state
  const documentEntityTypes = resource.entityTypes || [];

  // Get primary representation metadata
  const primaryRep = getPrimaryRepresentation(resource);
  const primaryMediaType = primaryRep?.mediaType;
  const primaryByteSize = primaryRep?.byteSize;

  // Annotate mode state - read-only copy for sidebar panel coordination
  // ResourceViewer manages the authoritative state and persists to localStorage
  const [annotateMode, _setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });

  // Unified annotation state (motivation-agnostic) - used by sidebar panels
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  // focusedAnnotationId removed - now managed internally by each panel via event bus
  // scrollToAnnotationId removed - ResourceViewer now manages scroll state internally

  // Panel state - managed internally via event bus
  const [activePanel, setActivePanelInternal] = useState<string | null>(() => {
    // Load from localStorage if available (for persistence across page reloads)
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('activeToolbarPanel');
      return saved || null;
    }
    return null;
  });

  // Unified pending annotation - all human-created annotations flow through this
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingAnnotation | null>(null);

  // Search state
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [pendingReferenceId, setPendingReferenceId] = useState<string | null>(null);

  // Generation config modal state
  const [generationModalOpen, setGenerationModalOpen] = useState(false);
  const [generationReferenceId, setGenerationReferenceId] = useState<string | null>(null);
  const [generationDefaultTitle, setGenerationDefaultTitle] = useState('');

  // Unified detection state (motivation-based)
  const [detectingMotivation, setDetectingMotivation] = useState<Motivation | null>(null);
  const [motivationDetectionProgress, setMotivationDetectionProgress] = useState<DetectionProgress | null>(null);

  // SSE stream reference for cancellation
  const detectionStreamRef = React.useRef<any>(null);

  // Handle event hover - trigger sparkle animation
  const handleEventHover = useCallback((annotationId: string | null) => {
    setHoveredAnnotationId(annotationId);
    if (annotationId) {
      eventBus.emit('annotation:sparkle', { annotationId });
    }
  }, [eventBus]);

  // Handle event click - scroll handled internally by ResourceViewer now
  const handleEventClick = useCallback((_annotationId: string | null) => {
    // ResourceViewer now manages scroll state internally
  }, []);

  // Use SSE-based document generation progress - provides inline sparkle animation
  const {
    progress: generationProgress,
    startGeneration,
    clearProgress
  } = useGenerationProgress({
    onComplete: (progress) => {
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
    onError: (error) => {
      console.error('[Generation] Error:', error);
      showError(`Resource generation failed: ${error}`);
    }
  });

  // Generic cancel handler (works for all detection types)
  const handleCancelDetection = useCallback(
    () => createCancelDetectionHandler({
      detectionStreamRef,
      setDetectingMotivation,
      setMotivationDetectionProgress
    })(),
    []
  );

  // Handle document generation from stub reference
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

    // Modal submitted with full options including context - proceed with generation
    if (!resource) return;

    // Clear CSS sparkle animation if reference was recently created
    clearNewAnnotationId(annotationUri(referenceId));

    // Use full resource URI (W3C Web Annotation spec requires URIs)
    const resourceUriStr = resource['@id'];
    startGeneration(annotationUri(referenceId), resourceUri(resourceUriStr), {
      ...options,
      // Use language from modal if provided, otherwise fall back to current locale
      language: options.language || locale,
      context: options.context
    });
  }, [startGeneration, resource, clearNewAnnotationId, locale]);



  // Announce content loading state changes
  useEffect(() => {
    if (contentLoading) {
      announceResourceLoading(resource.name);
    } else if (content) {
      announceResourceLoaded(resource.name);
    }
  }, [contentLoading, content, resource.name, announceResourceLoading, announceResourceLoaded]);

  // Unified annotation request handler - all human-created annotations flow through this
  const handleAnnotationRequested = useCallback((pending: PendingAnnotation) => {
    // Route to appropriate panel tab based on motivation
    const MOTIVATION_TO_TAB: Record<Motivation, string> = {
      highlighting: 'annotations',
      commenting: 'annotations',
      assessing: 'annotations',
      tagging: 'annotations',
      linking: 'annotations',
      bookmarking: 'annotations',
      classifying: 'annotations',
      describing: 'annotations',
      editing: 'annotations',
      identifying: 'annotations',
      moderating: 'annotations',
      questioning: 'annotations',
      replying: 'annotations',
    };

    // Emit event to open the appropriate panel
    eventBus.emit('panel:open', { panel: MOTIVATION_TO_TAB[pending.motivation] || 'annotations' });
    setPendingAnnotation(pending);
  }, [eventBus]);

  // Subscribe to UI events from ResourceViewer
  useEventSubscriptions({
    'selection:comment-requested': (selection: any) => {
      handleAnnotationRequested({
        selector: {
          type: 'TextQuoteSelector',
          exact: selection.exact,
          start: selection.start,
          end: selection.end,
          ...(selection.prefix && { prefix: selection.prefix }),
          ...(selection.suffix && { suffix: selection.suffix })
        },
        motivation: 'commenting'
      });
    },
    'selection:tag-requested': (selection: any) => {
      handleAnnotationRequested({
        selector: {
          type: 'TextQuoteSelector',
          exact: selection.exact,
          start: selection.start,
          end: selection.end,
          ...(selection.prefix && { prefix: selection.prefix }),
          ...(selection.suffix && { suffix: selection.suffix })
        },
        motivation: 'tagging'
      });
    },
    'selection:assessment-requested': (selection: any) => {
      handleAnnotationRequested({
        selector: {
          type: 'TextQuoteSelector',
          exact: selection.exact,
          start: selection.start,
          end: selection.end,
          ...(selection.prefix && { prefix: selection.prefix }),
          ...(selection.suffix && { suffix: selection.suffix })
        },
        motivation: 'assessing'
      });
    },
    'selection:reference-requested': (selection: any) => {
      // Build selector based on what's present in the selection
      let selector: any;

      if (selection.svgSelector) {
        selector = {
          type: 'SvgSelector',
          value: selection.svgSelector
        };
      } else if (selection.fragmentSelector) {
        selector = {
          type: 'FragmentSelector',
          value: selection.fragmentSelector,
          ...(selection.conformsTo && { conformsTo: selection.conformsTo })
        };
      } else {
        selector = {
          type: 'TextQuoteSelector',
          exact: selection.exact,
          start: selection.start,
          end: selection.end,
          ...(selection.prefix && { prefix: selection.prefix }),
          ...(selection.suffix && { suffix: selection.suffix })
        };
      }

      handleAnnotationRequested({
        selector,
        motivation: 'linking'
      });
    },
    'annotation:cancel-pending': () => {
      setPendingAnnotation(null);
    },
    'annotation:click': ({ annotationId }: { annotationId: string }) => {
      eventBus.emit('annotation:focus', { annotationId });
      setHoveredAnnotationId(annotationId);
      setTimeout(() => setHoveredAnnotationId(null), 1500);
    },
    'panel:toggle': ({ panel }: { panel: string }) => {
      setActivePanelInternal(current => {
        const newPanel = current === panel ? null : panel;
        // Persist to localStorage
        if (typeof window !== 'undefined') {
          if (newPanel) {
            localStorage.setItem('activeToolbarPanel', newPanel);
          } else {
            localStorage.removeItem('activeToolbarPanel');
          }
        }
        return newPanel;
      });
    },
    'panel:open': ({ panel }: { panel: string }) => {
      setActivePanelInternal(panel);
      if (typeof window !== 'undefined') {
        localStorage.setItem('activeToolbarPanel', panel);
      }
    },
    'panel:close': () => {
      setActivePanelInternal(null);
      if (typeof window !== 'undefined') {
        localStorage.removeItem('activeToolbarPanel');
      }
    },
    'job:cancel-requested': ({ jobType }: { jobType: 'detection' | 'generation' }) => {
      if (jobType === 'detection') {
        handleCancelDetection();
      }
      // Generation cancellation can be added here when needed
    },
    'reference:search-modal-open': ({ referenceId }: { referenceId: string; searchTerm: string }) => {
      setPendingReferenceId(referenceId);
      setSearchModalOpen(true);
      // Note: searchTerm is available in the event but SearchResourcesModal manages its own search state
    },
  });

  // Manual tag creation handler
  // Note: handleAnnotationClick removed - now handled via event bus subscriptions

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

  // handleAnnotationClickAndFocus removed - ResourceViewer now manages focus/click state internally

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
                onAnnotationRequested={handleAnnotationRequested}
                generatingReferenceId={generationProgress?.referenceId ?? null}
                showLineNumbers={showLineNumbers}
                annotators={ANNOTATORS}
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
                detectionProgress={motivationDetectionProgress}
                pendingAnnotation={pendingAnnotation}
                allEntityTypes={allEntityTypes}
                generatingReferenceId={generationProgress?.referenceId ?? null}
                referencedBy={referencedBy}
                referencedByLoading={referencedByLoading}
                resourceId={rUri.split('/').pop() || ''}
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
        onClose={() => {
          setSearchModalOpen(false);
          setPendingReferenceId(null);
        }}
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
              setSearchModalOpen(false);
              setPendingReferenceId(null);
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
        onClose={() => {
          setGenerationModalOpen(false);
          setGenerationReferenceId(null);
        }}
        onGenerate={(options: GenerationOptions) => {
          if (generationReferenceId) {
            handleGenerateDocument(generationReferenceId, options);
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
