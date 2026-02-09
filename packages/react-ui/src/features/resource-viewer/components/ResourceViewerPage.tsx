/**
 * ResourceViewerPage - Pure React component for viewing resources
 *
 * No Next.js dependencies - receives all data and callbacks via props.
 * This component handles the UI rendering and state management for the resource viewer.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
import { MakeMeaningEventBusProvider, useMakeMeaningEvents } from '@semiont/react-ui';

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
  onThemeChange: (theme: any) => void;

  /**
   * Line numbers state
   */
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;

  /**
   * Active toolbar panel
   */
  activePanel: any;
  onPanelToggle: (panel: any) => void;
  setActivePanel: (panel: any) => void;

  /**
   * Callbacks for resource actions
   */
  onArchive: () => Promise<void>;
  onUnarchive: () => Promise<void>;
  onClone: () => Promise<void>;
  onUpdateAnnotationBody: (annotationUri: string, data: any) => Promise<void>;

  /**
   * Annotation CRUD callbacks
   */
  onCreateAnnotation: (
    rUri: ResourceUri,
    motivation: Motivation,
    selector: any,
    body: any[]
  ) => Promise<void>;
  onTriggerSparkleAnimation: (annotationId: string) => void;
  onClearNewAnnotationId: (annotationId: string) => void;

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
   * API client
   */
  client: any;

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
  onThemeChange,
  showLineNumbers,
  onLineNumbersToggle,
  activePanel,
  onPanelToggle,
  setActivePanel,
  onArchive,
  onUnarchive,
  onClone,
  onUpdateAnnotationBody,
  onCreateAnnotation,
  onTriggerSparkleAnimation,
  onClearNewAnnotationId,
  showSuccess,
  showError,
  cacheManager,
  client,
  Link,
  routes,
  ToolbarPanels,
  SearchResourcesModal,
  GenerationConfigModal,
}: ResourceViewerPageProps) {
  // Get unified event bus for subscribing to UI events
  const eventBus = useMakeMeaningEvents();
  // Resource loading announcements
  const {
    announceResourceLoading,
    announceResourceLoaded
  } = useResourceLoadingAnnouncements();

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
  const [focusedAnnotationId, _setFocusedAnnotationId] = useState<string | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  // scrollToAnnotationId removed - ResourceViewer now manages scroll state internally

  // Unified pending annotation - all human-created annotations flow through this
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingAnnotation | null>(null);

  // Search state
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
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
      onTriggerSparkleAnimation(annotationId);
    }
  }, [onTriggerSparkleAnimation]);

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
    onComplete: () => {
      // Clear progress widget
      setTimeout(() => clearProgress(), 1000);
    },
    onError: (error) => {
      console.error('[Generation] Error:', error);
    }
  });

  // Generic detection context for all annotation types
  // Memoized to keep stable reference
  // Note: State setters (setDetectingMotivation, setMotivationDetectionProgress) are stable and don't need deps
  const detectionContext = useMemo(() => ({
    client,
    rUri,
    setDetectingMotivation,
    setMotivationDetectionProgress,
    detectionStreamRef,
    cacheManager,
    showSuccess,
    showError
  }), [client, rUri, cacheManager, showSuccess, showError]);

  // Generic cancel handler (works for all detection types)
  const handleCancelDetection = React.useMemo(
    () => createCancelDetectionHandler({
      detectionStreamRef,
      setDetectingMotivation,
      setMotivationDetectionProgress
    }),
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
    onClearNewAnnotationId(annotationUri(referenceId));

    // Use full resource URI (W3C Web Annotation spec requires URIs)
    const resourceUriStr = resource['@id'];
    startGeneration(annotationUri(referenceId), resourceUri(resourceUriStr), {
      ...options,
      // Use language from modal if provided, otherwise fall back to current locale
      language: options.language || locale,
      context: options.context
    });
  }, [startGeneration, resource, onClearNewAnnotationId, locale]);

  // Handle manual document creation from stub reference
  const handleCreateDocument = useCallback((
    annotationUri: string,
    title: string,
    entityTypes: string[]
  ) => {
    if (!resource) return;

    // Extract resource ID from URI
    const resourceId = rUri.split('/').pop() || '';

    // Navigate to compose page with reference context
    const entityTypesStr = entityTypes.join(',');
    const params = new URLSearchParams({
      name: title,  // Compose page expects 'name' parameter
      annotationUri,  // Pass full annotation URI, not just ID
      sourceDocumentId: resourceId,
      ...(entityTypes.length > 0 ? { entityTypes: entityTypesStr } : {}),
    });

    window.location.href = `/know/compose?${params.toString()}`;
  }, [resource, rUri]);

  // Handle search for documents to link to reference
  const handleSearchDocuments = useCallback((referenceId: string, searchTerm: string) => {
    setPendingReferenceId(referenceId);
    setSearchTerm(searchTerm);
    setSearchModalOpen(true);
  }, []);


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

    setActivePanel(MOTIVATION_TO_TAB[pending.motivation] || 'annotations');
    setPendingAnnotation(pending);
  }, [setActivePanel]);

  // Subscribe to UI events from ResourceViewer
  useEffect(() => {
    const handleCommentRequested = (selection: any) => {
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
    };

    const handleTagRequested = (selection: any) => {
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
    };

    const handleAssessmentRequested = (selection: any) => {
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
    };

    const handleReferenceRequested = (selection: any) => {
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
    };

    eventBus.on('ui:selection:comment-requested', handleCommentRequested);
    eventBus.on('ui:selection:tag-requested', handleTagRequested);
    eventBus.on('ui:selection:assessment-requested', handleAssessmentRequested);
    eventBus.on('ui:selection:reference-requested', handleReferenceRequested);

    return () => {
      eventBus.off('ui:selection:comment-requested', handleCommentRequested);
      eventBus.off('ui:selection:tag-requested', handleTagRequested);
      eventBus.off('ui:selection:assessment-requested', handleAssessmentRequested);
      eventBus.off('ui:selection:reference-requested', handleReferenceRequested);
    };
  }, [eventBus, handleAnnotationRequested]);

  // Manual tag creation handler
  // Shared UI handlers - same across all annotation types
  const handleAnnotationClick = useCallback((annotation: Annotation) => {
    setHoveredAnnotationId(annotation.id);
    setTimeout(() => setHoveredAnnotationId(null), 1500);
  }, []);

  const handleAnnotationHover = useCallback((annotationId: string | null) => {
    setHoveredAnnotationId(annotationId);
  }, []);

  // Single generic annotation creation handler - reads config from ANNOTATORS
  const handleCreateAnnotation = useCallback(async (
    motivation: Motivation,
    ...args: any[]
  ) => {
    if (!pendingAnnotation || pendingAnnotation.motivation !== motivation) return;

    // Find the config for this motivation
    const annotatorConfig = Object.values(ANNOTATORS).find(a => a.motivation === motivation);
    if (!annotatorConfig) return;

    try {
      let body: any[] = [];
      let selector = pendingAnnotation.selector;

      // Build body based on config
      switch (annotatorConfig.create.bodyBuilder) {
        case 'empty':
          // args[0] might be selector for highlight/assessment
          if (args[0]) selector = args[0];
          body = [];
          break;

        case 'text':
          // args[0] is commentText
          body = [{
            type: 'TextualBody',
            value: args[0],
            format: 'text/plain',
            purpose: 'commenting'
          }];
          break;

        case 'entityTag':
          // args[0] is optional entityType
          if (args[0]) {
            body = [{
              type: 'TextualBody',
              purpose: 'tagging',
              value: args[0]
            }];
          }
          break;

        case 'dualTag':
          // args[0] is schemaId, args[1] is category
          body = [
            {
              type: 'TextualBody',
              purpose: 'tagging',
              value: args[1] // category
            },
            {
              type: 'TextualBody',
              purpose: 'classifying',
              value: args[0] // schemaId
            }
          ];
          break;
      }

      await onCreateAnnotation(rUri, motivation, selector, body);
      setPendingAnnotation(null);

      // Cache invalidation now handled by annotation:added event

      if (annotatorConfig.create.successMessage) {
        const message = annotatorConfig.create.successMessage.replace('{value}', args[1] || '');
        showSuccess(message);
      }
    } catch (error) {
      console.error(`Failed to create ${annotatorConfig.internalType}:`, error);
      showError(`Failed to create ${annotatorConfig.displayName.toLowerCase()}`);
    }
  }, [pendingAnnotation, onCreateAnnotation, rUri, showSuccess, showError]);

  // Group annotations by type using static ANNOTATORS
  const groups = useMemo(() => {
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

    return result;
  }, [annotations]);

  // Memoize resource with content to prevent infinite re-renders
  const resourceWithContent = useMemo(
    () => ({ ...resource, content }),
    [resource, content]
  );

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
            onThemeChange={onThemeChange}
            showLineNumbers={showLineNumbers}
            onLineNumbersToggle={onLineNumbersToggle}
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
                onCreateAnnotation={handleCreateAnnotation}
                detectionContext={detectionContext}
                focusedAnnotationId={focusedAnnotationId}
                hoveredAnnotationId={hoveredAnnotationId}
                onAnnotationClick={handleAnnotationClick}
                onAnnotationHover={handleAnnotationHover}
                annotateMode={annotateMode}
                detectingMotivation={detectingMotivation}
                detectionProgress={motivationDetectionProgress}
                pendingAnnotation={pendingAnnotation}
                allEntityTypes={allEntityTypes}
                onGenerateDocument={handleGenerateDocument}
                onCreateDocument={handleCreateDocument}
                generatingReferenceId={generationProgress?.referenceId ?? null}
                onSearchDocuments={handleSearchDocuments}
                onCancelDetection={handleCancelDetection}
                {...(primaryMediaType ? { mediaType: primaryMediaType } : {})}
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
                onClone={onClone}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
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
            onPanelToggle={onPanelToggle}
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

              await onUpdateAnnotationBody(resourceAnnotationUri(nestedUri), {
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
        searchTerm={searchTerm}
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

// Outer component that wraps MakeMeaningEventBusProvider
export function ResourceViewerPage(props: ResourceViewerPageProps) {
  return (
    <MakeMeaningEventBusProvider rUri={props.rUri}>
      <ResourceViewerPageInner {...props} />
    </MakeMeaningEventBusProvider>
  );
}
