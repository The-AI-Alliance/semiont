/**
 * ResourceViewerPage - Pure React component for viewing resources
 *
 * No Next.js dependencies - receives all data and callbacks via props.
 * This component handles the UI rendering and state management for the resource viewer.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from '@semiont/react-ui';
import { ResourceViewer } from '@semiont/react-ui';
import { buttonStyles } from '@semiont/react-ui';
import type { components, ResourceUri, GenerationContext } from '@semiont/api-client';
import { getResourceId, getLanguage, getPrimaryMediaType, getPrimaryRepresentation, annotationUri, resourceUri, resourceAnnotationUri } from '@semiont/api-client';
import { groupAnnotationsByType, withHandlers, createDetectionHandler, createCancelDetectionHandler, ANNOTATORS } from '@semiont/react-ui';
import { supportsDetection } from '@semiont/react-ui';
import { ErrorBoundary } from '@semiont/react-ui';
import { DetectionProgressWidget } from '@semiont/react-ui';
import { useGenerationProgress } from '@semiont/react-ui';
import { AnnotationHistory } from '@semiont/react-ui';
import { useDebouncedCallback } from '@semiont/react-ui';
import { UnifiedAnnotationsPanel } from '@semiont/react-ui';
import { ResourceInfoPanel } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { CollaborationPanel } from '@semiont/react-ui';
import { JsonLdPanel } from '@semiont/react-ui';
import { Toolbar } from '@semiont/react-ui';
import { SearchResourcesModal } from '@/components/modals/SearchResourcesModal';
import { GenerationConfigModal } from '@/components/modals/GenerationConfigModal';
import type { SemiontResource, Annotation, Motivation, TextSelection, DetectionProgress } from '../types';

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
  onUpdateDocumentTags: (tags: string[]) => Promise<void>;
  onArchive: () => Promise<void>;
  onUnarchive: () => Promise<void>;
  onClone: () => Promise<void>;
  onUpdateAnnotationBody: (annotationUri: string, data: any) => Promise<void>;
  onRefetchAnnotations: () => Promise<void>;

  /**
   * Annotation CRUD callbacks
   */
  onCreateAnnotation: (
    rUri: ResourceUri,
    motivation: Motivation,
    selector: any,
    body: any[]
  ) => Promise<void>;
  onDeleteAnnotation: (annotationId: string) => Promise<void>;
  onTriggerSparkleAnimation: (annotationId: string) => void;
  onClearNewAnnotationId: (annotationId: string) => void;

  /**
   * Toast notifications
   */
  showSuccess: (message: string) => void;
  showError: (message: string) => void;

  /**
   * Real-time event handlers
   */
  onAnnotationAdded: (event: any) => void;
  onAnnotationRemoved: (event: any) => void;
  onAnnotationBodyUpdated: (event: any) => void;
  onDocumentArchived: (event: any) => void;
  onDocumentUnarchived: (event: any) => void;
  onEntityTagAdded: (event: any) => void;
  onEntityTagRemoved: (event: any) => void;
  onEventError: (error: any) => void;

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
}

export function ResourceViewerPage({
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
  onUpdateDocumentTags,
  onArchive,
  onUnarchive,
  onClone,
  onUpdateAnnotationBody,
  onRefetchAnnotations,
  onCreateAnnotation,
  onDeleteAnnotation,
  onTriggerSparkleAnimation,
  onClearNewAnnotationId,
  showSuccess,
  showError,
  onAnnotationAdded,
  onAnnotationRemoved,
  onAnnotationBodyUpdated,
  onDocumentArchived,
  onDocumentUnarchived,
  onEntityTagAdded,
  onEntityTagRemoved,
  onEventError,
  cacheManager,
  client,
  Link,
  routes,
}: ResourceViewerPageProps) {
  const queryClient = useQueryClient();

  // Group annotations by type using centralized registry
  const groups = groupAnnotationsByType(annotations);
  const highlights = groups.highlight || [];
  const references = groups.reference || [];
  const assessments = groups.assessment || [];
  const comments = groups.comment || [];
  const tags = groups.tag || [];

  // Derived state
  const documentEntityTypes = resource.entityTypes || [];

  // Get primary representation metadata
  const primaryRep = getPrimaryRepresentation(resource);
  const primaryMediaType = primaryRep?.mediaType;
  const primaryByteSize = primaryRep?.byteSize;

  const [annotateMode, setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });

  // Unified annotation state (motivation-agnostic)
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const [scrollToAnnotationId, setScrollToAnnotationId] = useState<string | null>(null);

  // Pending selections for creating annotations
  const [pendingCommentSelection, setPendingCommentSelection] = useState<TextSelection | null>(null);
  const [pendingTagSelection, setPendingTagSelection] = useState<TextSelection | null>(null);
  const [pendingReferenceSelection, setPendingReferenceSelection] = useState<TextSelection | null>(null);

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

  // Handle event click - scroll to annotation
  const handleEventClick = useCallback((annotationId: string | null) => {
    setScrollToAnnotationId(annotationId);
  }, []);

  // Handle annotate mode toggle - memoized
  const handleAnnotateModeToggle = useCallback(() => {
    const newMode = !annotateMode;
    setAnnotateMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('annotateMode', newMode.toString());
    }
  }, [annotateMode]);

  // Use SSE-based document generation progress - provides inline sparkle animation
  const {
    progress: generationProgress,
    startGeneration,
    clearProgress
  } = useGenerationProgress({
    onComplete: (progress) => {
      // Clear progress widget
      setTimeout(() => clearProgress(), 1000);
    },
    onError: (error) => {
      console.error('[Generation] Error:', error);
    }
  });

  // Generic detection context for all annotation types
  const detectionContext = {
    client,
    rUri,
    setDetectingMotivation,
    setMotivationDetectionProgress,
    detectionStreamRef,
    cacheManager,
    showSuccess,
    showError
  };

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

  // Handle search for documents to link to reference
  const handleSearchDocuments = useCallback((referenceId: string, searchTerm: string) => {
    setPendingReferenceId(referenceId);
    setSearchTerm(searchTerm);
    setSearchModalOpen(true);
  }, []);

  // Handle unlinking a reference (clearing the body)
  const handleUpdateReference = useCallback(async (referenceId: string, updates: Partial<Annotation>) => {
    try {
      // Extract short annotation ID from the full URI
      const annotationIdShort = referenceId.split('/').pop();
      if (!annotationIdShort) {
        throw new Error('Invalid reference ID');
      }

      // Construct the nested URI format required by the API
      const resourceIdSegment = rUri.split('/').pop() || '';
      const nestedUri = `${window.location.origin}/resources/${resourceIdSegment}/annotations/${annotationIdShort}`;

      // Check if we're clearing the body (unlinking)
      const isClearing = Array.isArray(updates.body) && updates.body.length === 0;

      if (isClearing) {
        // Find the actual reference to get its body items
        const reference = references.find(r => r.id === referenceId);
        if (!reference) {
          throw new Error('Reference not found');
        }

        // Extract body items with purpose === 'linking' and create remove operations
        const bodyArray = Array.isArray(reference.body) ? reference.body : [];
        const operations = bodyArray
          .filter((item: any) => item.purpose === 'linking')
          .map((item: any) => ({
            op: 'remove' as const,
            item,
          }));

        if (operations.length === 0) {
          throw new Error('No linking body items found to remove');
        }

        await onUpdateAnnotationBody(resourceAnnotationUri(nestedUri), {
          resourceId: resourceIdSegment,
          operations,
        });
        showSuccess('Reference unlinked successfully');
      }

      await onRefetchAnnotations();
    } catch (error) {
      console.error('Failed to update reference:', error);
      showError('Failed to update reference');
    }
  }, [rUri, references, onUpdateAnnotationBody, onRefetchAnnotations, showSuccess, showError]);

  // Manual tag creation handler
  const handleCreateTag = useCallback(async (
    selection: { exact: string; start: number; end: number },
    schemaId: string,
    category: string
  ) => {
    try {
      // Create tag annotation with dual-body structure
      await onCreateAnnotation(
        rUri,
        'tagging',
        [
          {
            type: 'TextPositionSelector',
            start: selection.start,
            end: selection.end
          },
          {
            type: 'TextQuoteSelector',
            exact: selection.exact
          }
        ],
        [
          {
            type: 'TextualBody',
            purpose: 'tagging',
            value: category
          },
          {
            type: 'TextualBody',
            purpose: 'classifying',
            value: schemaId
          }
        ]
      );

      setPendingTagSelection(null);
      await onRefetchAnnotations();
      showSuccess(`Tag "${category}" created`);
    } catch (error) {
      console.error('Failed to create tag:', error);
      showError('Failed to create tag');
    }
  }, [onCreateAnnotation, rUri, onRefetchAnnotations, showSuccess, showError]);

  // Document rendering
  return (
    <div className="flex flex-col h-full">
      {/* Main Content - Fills remaining height */}
      <div className="flex flex-1 overflow-hidden">
        {/* Document Content - Left Side */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Document Header - Only spans document content width */}
          <div className="flex-none bg-white dark:bg-gray-800 shadow-sm rounded-t-lg">
            <div className="px-6 py-2 flex items-center justify-between gap-4">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                {resource.name}
              </h2>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <ErrorBoundary
              fallback={(error, reset) => (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
                  <h3 className="text-sm font-semibold text-red-800 dark:text-red-300 mb-1">
                    Error loading document viewer
                  </h3>
                  <p className="text-sm text-red-700 dark:text-red-400">
                    {error.message}
                  </p>
                  <button
                    onClick={reset}
                    className="mt-2 text-sm text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300 underline"
                  >
                    Try again
                  </button>
                </div>
              )}
            >
              {contentLoading ? (
                <div className="p-8 flex items-center justify-center text-gray-600 dark:text-gray-300">
                  Loading document content...
                </div>
              ) : (
                <ResourceViewer
                  resource={{ ...resource, content }}
                annotations={{ highlights, references, assessments, comments, tags }}
                onRefetchAnnotations={() => {
                  // Don't refetch immediately - the SSE event will trigger invalidation after projection is updated
                }}
                annotateMode={annotateMode}
                onAnnotateModeToggle={handleAnnotateModeToggle}
                onCommentCreationRequested={(selection) => {
                  setPendingCommentSelection(selection);
                  setActivePanel('annotations');
                }}
                onTagCreationRequested={(selection) => {
                  setPendingTagSelection(selection);
                  setActivePanel('annotations');
                }}
                onReferenceCreationRequested={(selection: TextSelection) => {
                  setPendingReferenceSelection(selection);
                  setActivePanel('annotations');
                }}
                onCommentClick={(commentId) => {
                  setActivePanel('annotations');
                  setFocusedAnnotationId(commentId);
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                onReferenceClick={(referenceId) => {
                  setActivePanel('annotations');
                  setFocusedAnnotationId(referenceId);
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                onHighlightClick={(highlightId) => {
                  setActivePanel('annotations');
                  setFocusedAnnotationId(highlightId);
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                onAssessmentClick={(assessmentId) => {
                  setActivePanel('annotations');
                  setFocusedAnnotationId(assessmentId);
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                onTagClick={(tagId) => {
                  setActivePanel('annotations');
                  setFocusedAnnotationId(tagId);
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                generatingReferenceId={generationProgress?.referenceId ?? null}
                onAnnotationHover={setHoveredAnnotationId}
                onCommentHover={setHoveredAnnotationId}
                hoveredAnnotationId={hoveredAnnotationId}
                hoveredCommentId={hoveredAnnotationId}
                scrollToAnnotationId={scrollToAnnotationId}
                showLineNumbers={showLineNumbers}
              />
              )}
            </ErrorBoundary>
          </div>
        </div>

        {/* Sidebar */}
        <div className="flex">
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
              <div className="bg-gray-100 dark:bg-gray-700 rounded-lg shadow-sm p-3 mb-3">
                <div className="text-gray-600 dark:text-gray-400 text-sm font-medium text-center">
                  📦 Archived
                </div>
              </div>
            )}

            {/* Unified Annotations Panel */}
            {activePanel === 'annotations' && !resource.archived && (() => {
              // Create annotators with injected handlers
              const annotators = withHandlers({
                highlight: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.highlight!, detectionContext) } : {})
                },
                reference: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  onCreate: async (entityType?: string) => {
                    if (pendingReferenceSelection) {
                      const selector = pendingReferenceSelection.svgSelector
                        ? { type: 'SvgSelector' as const, value: pendingReferenceSelection.svgSelector }
                        : [
                            {
                              type: 'TextPositionSelector' as const,
                              start: pendingReferenceSelection.start,
                              end: pendingReferenceSelection.end
                            },
                            {
                              type: 'TextQuoteSelector' as const,
                              exact: pendingReferenceSelection.exact,
                              ...(pendingReferenceSelection.prefix && { prefix: pendingReferenceSelection.prefix }),
                              ...(pendingReferenceSelection.suffix && { suffix: pendingReferenceSelection.suffix })
                            }
                          ];

                      await onCreateAnnotation(
                        rUri,
                        'linking',
                        selector,
                        entityType ? [{
                          type: 'TextualBody',
                          purpose: 'tagging',
                          value: entityType
                        }] : []
                      );
                      setPendingReferenceSelection(null);
                      await onRefetchAnnotations();
                    }
                  },
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.reference!, detectionContext) } : {})
                },
                assessment: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.assessment!, detectionContext) } : {})
                },
                comment: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  onUpdate: async (annotationIdStr: string, newText: string) => {
                    // TODO: Implement update comment mutation
                  },
                  onCreate: async (commentText: string) => {
                    if (pendingCommentSelection) {
                      await onCreateAnnotation(rUri, 'commenting', [
                        {
                          type: 'TextPositionSelector',
                          start: pendingCommentSelection.start,
                          end: pendingCommentSelection.end,
                        },
                        {
                          type: 'TextQuoteSelector',
                          exact: pendingCommentSelection.exact,
                        }
                      ], [{
                        type: 'TextualBody',
                        value: commentText,
                        format: 'text/plain',
                        purpose: 'commenting',
                      }]);
                      setPendingCommentSelection(null);
                    }
                  },
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.comment!, detectionContext) } : {})
                },
                tag: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.tag!, detectionContext) } : {}),
                  ...(supportsDetection(primaryMediaType) ? { onCreate: handleCreateTag } : {})
                }
              });

              return (
                <UnifiedAnnotationsPanel
                  annotations={[...highlights, ...references, ...assessments, ...comments, ...tags]}
                  annotators={annotators}
                  focusedAnnotationId={focusedAnnotationId}
                  hoveredAnnotationId={hoveredAnnotationId}
                  annotateMode={annotateMode}
                  detectingMotivation={detectingMotivation}
                  detectionProgress={motivationDetectionProgress}
                  pendingCommentSelection={pendingCommentSelection}
                  pendingTagSelection={pendingTagSelection}
                  pendingReferenceSelection={pendingReferenceSelection}
                  allEntityTypes={allEntityTypes}
                  onGenerateDocument={handleGenerateDocument}
                  onSearchDocuments={handleSearchDocuments}
                  onUpdateReference={handleUpdateReference}
                  onCancelDetection={handleCancelDetection}
                  {...(primaryMediaType ? { mediaType: primaryMediaType } : {})}
                  referencedBy={referencedBy}
                  referencedByLoading={referencedByLoading}
                  resourceId={rUri.split('/').pop() || ''}
                  Link={Link}
                  routes={routes}
                />
              );
            })()}

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
              await onRefetchAnnotations();
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
        onGenerate={(options) => {
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
