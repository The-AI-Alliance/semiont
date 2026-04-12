/**
 * ResourceViewerPage - Self-contained resource viewer component
 *
 * Handles all data loading, event subscriptions, and side effects internally.
 * Only requires minimal props from the framework layer (routing, modals).
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { components, ResourceId, GatheredContext, EventMap } from '@semiont/core';
import { annotationId } from '@semiont/core';
import { getLanguage, getPrimaryRepresentation, getPrimaryMediaType, getMimeCategory } from '@semiont/api-client';
import { ANNOTATORS } from '@semiont/react-ui';
import { ErrorBoundary } from '@semiont/react-ui';
import { AnnotationHistory } from '@semiont/react-ui';
import { UnifiedAnnotationsPanel } from '@semiont/react-ui';
import { ResourceInfoPanel } from '@semiont/react-ui';
import { CollaborationPanel } from '@semiont/react-ui';
import { JsonLdPanel } from '@semiont/react-ui';
import { Toolbar } from '@semiont/react-ui';
import { useResourceLoadingAnnouncements } from '@semiont/react-ui';
import { ResourceViewer } from '@semiont/react-ui';
import { useObservable } from '@semiont/react-ui';
import { QUERY_KEYS } from '../../../lib/query-keys';
import { useResources, useEntityTypes } from '../../../lib/api-hooks';
import { useResourceContent } from '../../../hooks/useResourceContent';
import { useMediaToken } from '../../../hooks/useMediaToken';
import { useToast } from '../../../components/Toast';
import { useTheme } from '../../../contexts/ThemeContext';
import { useLineNumbers } from '../../../hooks/useLineNumbers';
import { useHoverDelay } from '../../../hooks/useHoverDelay';
import { useResourceEvents } from '../../../hooks/useResourceEvents';
import { useOpenResources } from '../../../contexts/OpenResourcesContext';
// Import EventBus hooks directly from context to avoid mocking issues in tests
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import { useResourceAnnotations } from '../../../contexts/ResourceAnnotationsContext';
import { useApiClient } from '../../../contexts/ApiClientContext';
import { useBindFlow } from '../../../hooks/useBindFlow';
import { useMarkFlow } from '../../../hooks/useMarkFlow';
import { useBeckonFlow } from '../../../hooks/useBeckonFlow';
import type { StreamStatus } from '../../../hooks/useResourceEvents';
import { usePanelBrowse } from '../../../hooks/usePanelBrowse';
import { useYieldFlow } from '../../../hooks/useYieldFlow';
import { useContextGatherFlow } from '../../../hooks/useContextGatherFlow';
import { useTranslations } from '../../../contexts/TranslationContext';
import { ReferenceWizardModal } from '../../../components/modals/ReferenceWizardModal';
import type { GenerationConfig } from '../../../components/modals/ConfigureGenerationStep';

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
  rUri: ResourceId;

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

  /**
   * Callback to refetch document from parent
   */
  refetchDocument: () => Promise<unknown>;

  /**
   * SSE attention stream connection status for the active workspace
   */
  streamStatus: StreamStatus;

  /**
   * Name of the active knowledge base (for display in panels)
   */
  knowledgeBaseName?: string | undefined;
}

/**
 * ResourceViewerPage - Main component
 *
 * Uses hooks directly (NO containers, NO render props, NO ResourceViewerPageContent wrapper)
 *
 * @emits browse:router-push - Navigate to a resource or filtered view
 * @emits beckon:sparkle - Trigger sparkle animation on an annotation
 * @emits bind:update-body - Update annotation body content
 * @subscribes mark:archive - Archive the current resource
 * @subscribes mark:unarchive - Unarchive the current resource
 * @subscribes yield:clone - Clone the current resource
 * @subscribes beckon:sparkle - Trigger sparkle animation
 * @subscribes mark:added - Annotation was created
 * @subscribes mark:removed - Annotation was deleted
 * @subscribes mark:create-failed - Annotation creation failed
 * @subscribes mark:delete-failed - Annotation deletion failed
 * @subscribes mark:body-updated - Annotation body was updated
 * @subscribes annotate:body-update-failed - Annotation body update failed
 * @subscribes settings:theme-changed - UI theme changed
 * @subscribes settings:line-numbers-toggled - Line numbers display toggled
 * @subscribes detection:complete - Detection completed
 * @subscribes detection:failed - Detection failed
 * @subscribes generation:complete - Generation completed
 * @subscribes generation:failed - Generation failed
 * @subscribes browse:reference-navigate - Navigate to a referenced document
 * @subscribes browse:entity-type-clicked - Navigate filtered by entity type
 */
export function ResourceViewerPage({
  resource,
  rUri,
  locale,
  Link,
  routes,
  ToolbarPanels,
  refetchDocument,
  streamStatus,
  knowledgeBaseName,
}: ResourceViewerPageProps) {
  // Translations
  const tw = useTranslations('ReferenceWizard');

  // Get unified event bus for subscribing to UI events
  const eventBus = useEventBus();
  const semiont = useApiClient();
  const queryClient = useQueryClient(); // retained for non-store queries (events log)

  // UI state hooks
  const { showError, showSuccess } = useToast();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();
  const { hoverDelayMs } = useHoverDelay();
  const { addResource } = useOpenResources();
  const { triggerSparkleAnimation, clearNewAnnotationId } = useResourceAnnotations();

  // API hooks
  const resources = useResources();
  const entityTypesAPI = useEntityTypes();

  // Determine MIME category to choose content path
  const resourceMediaType = getPrimaryMediaType(resource) || 'text/plain';
  const isBinary = getMimeCategory(resourceMediaType) === 'image';

  // Text path: fetch and decode representation (disabled for binary — mediaToken path handles those)
  const { content: textContent, loading: textLoading } = useResourceContent(rUri, resource, !isBinary);

  // Binary path: fetch short-lived media token, construct URL
  const { token: mediaToken, loading: mediaTokenLoading } = useMediaToken(rUri);
  const binaryContent = (isBinary && mediaToken && semiont)
    ? `${semiont.baseUrl}/api/resources/${rUri}?token=${mediaToken}`
    : '';

  const content = isBinary ? binaryContent : textContent;
  const contentLoading = isBinary ? mediaTokenLoading : textLoading;

  const annotationsData = useObservable(semiont.browse.annotations(rUri));
  const annotations = useMemo(
    () => annotationsData || [],
    [annotationsData]
  );

  const { data: referencedByData, isLoading: referencedByLoading } = resources.referencedBy.useQuery(rUri);
  const referencedBy = referencedByData?.referencedBy || [];

  const { data: entityTypesData } = entityTypesAPI.list.useQuery();
  const allEntityTypes = (entityTypesData as { entityTypes: string[] } | undefined)?.entityTypes || [];

  // Flow state hooks (NO CONTAINERS)
  const { hoveredAnnotationId } = useBeckonFlow();
  const { assistingMotivation, progress, pendingAnnotation } = useMarkFlow(rUri);
  const { activePanel, scrollToAnnotationId, panelInitialTab, onScrollCompleted } = usePanelBrowse();
  useBindFlow(rUri);
  const {
    generationProgress,
    onGenerateDocument,
  } = useYieldFlow(locale, rUri, clearNewAnnotationId);
  const { gatherContext, gatherLoading, gatherError } = useContextGatherFlow({ resourceId: rUri });

  // Wizard state — driven by bind:initiate from ReferenceEntry
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardAnnotationId, setWizardAnnotationId] = useState<string | null>(null);
  const [wizardResourceId, setWizardResourceId] = useState<string | null>(null);
  const [wizardDefaultTitle, setWizardDefaultTitle] = useState('');
  const [wizardEntityTypes, setWizardEntityTypes] = useState<string[]>([]);

  useEffect(() => {
    const subscription = eventBus.get('bind:initiate').subscribe((event) => {
      setWizardAnnotationId(event.annotationId);
      setWizardResourceId(event.resourceId);
      setWizardDefaultTitle(event.defaultTitle);
      setWizardEntityTypes(event.entityTypes);
      setWizardOpen(true);

      // Trigger context gathering — gather:requested is consumed by useContextGatherFlow
      eventBus.get('gather:requested').next({ correlationId: crypto.randomUUID(), annotationId: event.annotationId, resourceId: event.resourceId, options: { contextWindow: 2000 } });
    });
    return () => subscription.unsubscribe();
  }, [eventBus]);

  const handleWizardClose = useCallback(() => {
    setWizardOpen(false);
  }, []);

  const handleWizardGenerateSubmit = useCallback((referenceId: string, config: GenerationConfig) => {
    onGenerateDocument(referenceId, {
      title: config.title,
      storageUri: config.storagePath,
      prompt: config.prompt,
      language: config.language,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      context: config.context,
    });
  }, [onGenerateDocument]);

  const handleWizardLinkResource = useCallback(async (referenceId: string, targetResourceId: string) => {
    try {
      await semiont.bind.body(
        rUri,
        annotationId(referenceId),
        [{ op: 'add', item: { type: 'SpecificResource' as const, source: targetResourceId, purpose: 'linking' as const } }],
      );
      showSuccess('Reference linked successfully');
    } catch (error) {
      showError(`Failed to link reference: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [rUri, semiont, showSuccess, showError]);

  const handleWizardComposeNavigate = useCallback((
    context: GatheredContext,
    annId: string,
    resId: string,
    title: string,
    entTypes: string[],
  ) => {
    // Store context in sessionStorage for the compose page
    sessionStorage.setItem(`gather-context:${annId}`, JSON.stringify(context));
    const params = new URLSearchParams({
      annotationUri: annId,
      sourceDocumentId: resId,
      name: title,
      entityTypes: entTypes.join(','),
    });
    eventBus.get('browse:router-push').next({
      path: `/know/compose?${params.toString()}`,
      reason: 'compose-from-wizard',
    });
  }, []); // eventBus is stable singleton

  // Add resource to open tabs when it loads
  useEffect(() => {
    if (resource && rUri) {
      const mediaType = getPrimaryMediaType(resource);
      addResource(rUri, resource.name, mediaType || undefined, resource.storageUri);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lastViewedDocumentId', rUri);
      }
    }
  }, [resource, rUri, addResource]);

  // Real-time document events (SSE)
  // Annotation updates are handled by AnnotationStore reacting to EventBus events.
  // Callbacks here only handle non-annotation side effects.
  useResourceEvents({
    rUri,
    autoConnect: true,

    onAnnotationAdded: useCallback((_event: any) => {
      // Store handles annotation refresh; events log needs explicit invalidation
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(rUri) });
    }, [queryClient, rUri]),

    onAnnotationRemoved: useCallback((_event: any) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(rUri) });
    }, [queryClient, rUri]),

    onAnnotationBodyUpdated: useCallback((_event: any) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(rUri) });
    }, [queryClient, rUri]),

    // Document status events
    onDocumentArchived: useCallback((_event: any) => {
      refetchDocument();
      showSuccess('This document has been archived');
    }, [refetchDocument, showSuccess]),

    onDocumentUnarchived: useCallback((_event: any) => {
      refetchDocument();
      showSuccess('This document has been unarchived');
    }, [refetchDocument, showSuccess]),

    // Entity tag events
    onEntityTagAdded: useCallback((_event: any) => {
      refetchDocument();
    }, [refetchDocument]),

    onEntityTagRemoved: useCallback((_event: any) => {
      refetchDocument();
    }, [refetchDocument]),

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
      await updateMutation.mutateAsync({ id: rUri, data: { archived: true } });
      await refetchDocument();
    } catch (err) {
      console.error('Failed to archive document:', err);
      showError('Failed to archive document');
    }
  }, [updateMutation, rUri, refetchDocument, showError]);

  const handleResourceUnarchive = useCallback(async () => {
    try {
      await updateMutation.mutateAsync({ id: rUri, data: { archived: false } });
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
      eventBus.get('browse:router-push').next({ path: `/know/compose?mode=clone&token=${token}`, reason: 'clone' });
    } catch (err) {
      console.error('Failed to generate clone token:', err);
      showError('Failed to generate clone link');
    }
  }, [generateCloneTokenMutation, rUri, showError]);

  const handleAnnotationSparkle = useCallback(({ annotationId }: { annotationId: string }) => {
    triggerSparkleAnimation(annotationId);
  }, [triggerSparkleAnimation]);

  const handleAnnotationAdded = useCallback((stored: EventMap['mark:added']) => {
    triggerSparkleAnimation(stored.payload.annotation.id);
  }, [triggerSparkleAnimation]);

  const handleAnnotationCreateFailed = useCallback(() => showError('Failed to create annotation'), [showError]);
  const handleAnnotationDeleteFailed = useCallback(() => showError('Failed to delete annotation'), [showError]);
  const handleAnnotateBodyUpdated = useCallback(() => {
    // Success - optimistic update already applied via useResourceEvents
  }, []);
  const handleAnnotateBodyUpdateFailed = useCallback(() => showError('Failed to update annotation'), [showError]);

  const handleSettingsThemeChanged = useCallback(({ theme }: { theme: any }) => setTheme(theme), [setTheme]);

  const handleDetectionComplete = useCallback(() => {
    // Toast notification is handled by useMarkFlow; store handles annotation refresh
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(rUri) });
  }, [queryClient, rUri]);
  const handleDetectionFailed = useCallback(() => {
    // Error notification is handled by useMarkFlow; store handles annotation refresh
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(rUri) });
  }, [queryClient, rUri]);
  const handleGenerationComplete = useCallback(() => {
    // Toast notification is handled by useYieldFlow
  }, []);
  const handleGenerationFailed = useCallback(() => {
    // Error notification is handled by useYieldFlow
  }, []);

  const handleReferenceNavigate = useCallback(({ resourceId }: { resourceId: string }) => {
    if (routes.resourceDetail) {
      const path = routes.resourceDetail(resourceId);
      eventBus.get('browse:router-push').next({ path, reason: 'reference-link' });
    }
  }, [routes.resourceDetail]); // eventBus is stable singleton - never in deps

  const handleEntityTypeClicked = useCallback(({ entityType }: { entityType: string }) => {
    if (routes.know) {
      const path = `${routes.know}?entityType=${encodeURIComponent(entityType)}`;
      eventBus.get('browse:router-push').next({ path, reason: 'entity-type-filter' });
    }
  }, [routes.know]); // eventBus is stable singleton - never in deps

  const handleModeToggled = useCallback(() => {
    setAnnotateMode(prev => !prev);
  }, []);

  // Event bus subscriptions (combined into single useEventSubscriptions call to prevent hook ordering issues)
  useEventSubscriptions({
    'mark:mode-toggled': handleModeToggled,
    'mark:archive': handleResourceArchive,
    'mark:unarchive': handleResourceUnarchive,
    'yield:clone': handleResourceClone,
    'beckon:sparkle': handleAnnotationSparkle,
    'mark:added': handleAnnotationAdded,
    'mark:create-failed': handleAnnotationCreateFailed,
    'mark:delete-failed': handleAnnotationDeleteFailed,
    'mark:body-updated': handleAnnotateBodyUpdated,
    'bind:body-update-failed': handleAnnotateBodyUpdateFailed,
    'settings:theme-changed': handleSettingsThemeChanged,
    'settings:line-numbers-toggled': toggleLineNumbers,
    'mark:assist-finished': handleDetectionComplete,
    'mark:assist-failed': handleDetectionFailed,
    'yield:finished': handleGenerationComplete,
    'yield:failed': handleGenerationFailed,
    'browse:reference-navigate': handleReferenceNavigate,
    'browse:entity-type-clicked': handleEntityTypeClicked,
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

  // Annotate mode state - synced via mark:mode-toggled event from AnnotateToolbar
  const [annotateMode, setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });

  // Group annotations by type using static ANNOTATORS (memoized to avoid re-grouping on unrelated re-renders)
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

  // Combine resource with content
  const resourceWithContent = { ...resource, content };

  // Handlers for AnnotationHistory (legacy event-based interaction)
  const handleEventHover = useCallback((annotationId: string | null) => {
    if (annotationId) {
      eventBus.get('beckon:sparkle').next({ annotationId });
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
                  hoverDelayMs={hoverDelayMs}
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
            hoverDelayMs={hoverDelayMs}
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
                resourceId={rUri}
                locale={locale}
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
                resourceId={rUri}
                documentEntityTypes={documentEntityTypes}
                documentLocale={getLanguage(resource)}
                primaryMediaType={primaryMediaType}
                primaryByteSize={primaryByteSize}
                storageUri={resource.storageUri}
                isArchived={resource.archived ?? false}
                dateCreated={resource.dateCreated}
                dateModified={resource.dateModified}
                creationMethod={resource.creationMethod}
                wasAttributedTo={resource.wasAttributedTo}
                wasDerivedFrom={resource.wasDerivedFrom}
                generator={resource.generator as components['schemas']['Agent'] | components['schemas']['Agent'][] | undefined}
              />
            )}

            {/* Collaboration Panel */}
            {activePanel === 'collaboration' && (
              <CollaborationPanel
                isConnected={streamStatus === 'connected'}
                eventCount={0}
                knowledgeBaseName={knowledgeBaseName}
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

      {/* Reference Resolution Wizard */}
      <ReferenceWizardModal
        isOpen={wizardOpen}
        onClose={handleWizardClose}
        annotationId={wizardAnnotationId}
        resourceId={wizardResourceId}
        defaultTitle={wizardDefaultTitle}
        entityTypes={wizardEntityTypes}
        locale={locale}
        context={gatherContext}
        contextLoading={gatherLoading}
        contextError={gatherError}
        eventBus={eventBus}
        onGenerateSubmit={handleWizardGenerateSubmit}
        onLinkResource={handleWizardLinkResource}
        onComposeNavigate={handleWizardComposeNavigate}
        translations={{
          gatherTitle: tw('gatherTitle'),
          configureGenerationTitle: tw('configureGenerationTitle'),
          configureSearchTitle: tw('configureSearchTitle'),
          searchResultsTitle: tw('searchResultsTitle'),
          sourceContextLabel: tw('sourceContextLabel'),
          connectionsLabel: tw('connectionsLabel'),
          citedByLabel: tw('citedByLabel'),
          userHintLabel: tw('userHintLabel'),
          userHintPlaceholder: tw('userHintPlaceholder'),
          loadingContext: tw('loadingContext'),
          failedContext: tw('failedContext'),
          cancel: tw('cancel'),
          search: tw('search'),
          searching: tw('searching'),
          generate: tw('generate'),
          compose: tw('compose'),
          resolutionStrategyLabel: tw('resolutionStrategyLabel'),
          back: tw('back'),
          link: tw('link'),
          score: tw('score'),
          noResults: tw('noResults'),
          resourceTitle: tw('resourceTitle'),
          resourceTitlePlaceholder: tw('resourceTitlePlaceholder'),
          additionalInstructions: tw('additionalInstructions'),
          additionalInstructionsPlaceholder: tw('additionalInstructionsPlaceholder'),
          language: tw('language'),
          languageHelp: tw('languageHelp'),
          creativity: tw('creativity'),
          creativityFocused: tw('creativityFocused'),
          creativityCreative: tw('creativityCreative'),
          maxLength: tw('maxLength'),
          maxLengthHelp: tw('maxLengthHelp'),
          maxResults: tw('maxResults'),
          semanticScoring: tw('semanticScoring'),
          semanticScoringHelp: tw('semanticScoringHelp'),
        }}
      />
    </div>
  );
}
