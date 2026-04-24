/**
 * ResourceViewerPage - Self-contained resource viewer component
 *
 * Handles all data loading, event subscriptions, and side effects internally.
 * Only requires minimal props from the framework layer (routing, modals).
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { components, ResourceDescriptor, ResourceId, GatheredContext, EventMap } from '@semiont/core';
import type { ConnectionState } from '@semiont/api-client';
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
import { useResourceContent } from '../../../hooks/useResourceContent';
import { useMediaToken } from '../../../hooks/useMediaToken';
import { useToast } from '../../../components/Toast';
import { useTheme } from '../../../contexts/ThemeContext';
import { useLineNumbers } from '../../../hooks/useLineNumbers';
import { useHoverDelay } from '../../../hooks/useHoverDelay';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import { useResourceAnnotations } from '../../../contexts/ResourceAnnotationsContext';
import { useSemiont } from '../../../session/SemiontProvider';
import { createResourceViewerPageVM } from '@semiont/api-client';
import { useViewModel } from '../../../hooks/useViewModel';
import { useShellVM } from '../../../hooks/useShellVM';
import { useTranslations } from '../../../contexts/TranslationContext';
import { ReferenceWizardModal } from '../../../components/modals/ReferenceWizardModal';
import type { GenerationConfig } from '../../../components/modals/ConfigureGenerationStep';

type SemiontResource = ResourceDescriptor;

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
   * Bus connection state for the active workspace. Six-valued state
   * machine from `actor.state$`; CollaborationPanel maps it to the
   * "Live" / "Disconnected" visual.
   */
  streamStatus: ConnectionState;

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
 * @emits nav:push - Navigate to a resource or filtered view
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

  const browser = useSemiont();
  const session = useObservable(browser.activeSession$);
  const semiont = session?.client;

  // UI state hooks
  const { showError, showSuccess, showInfo } = useToast();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();
  const { hoverDelayMs } = useHoverDelay();
  const { triggerSparkleAnimation, clearNewAnnotationId } = useResourceAnnotations();

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

  // Composite VM — owns all flow VMs, wizard state, annotations, entity types
  const browseVM = useShellVM();
  const vm = useViewModel(() => createResourceViewerPageVM(semiont!, rUri, locale, browseVM));

  const annotations = useObservable(vm.annotations$) ?? [];
  const groups = useObservable(vm.annotationGroups$);
  const allEntityTypes = useObservable(vm.entityTypes$) ?? [];
  const referencedByRaw = useObservable(vm.referencedBy$);
  const referencedBy = referencedByRaw ?? [];
  const referencedByLoading = referencedByRaw === undefined;
  const hoveredAnnotationId = useObservable(vm.beckon.hoveredAnnotationId$) ?? null;
  const pendingAnnotation = useObservable(vm.mark.pendingAnnotation$) ?? null;
  const assistingMotivation = useObservable(vm.mark.assistingMotivation$) ?? null;
  const progress = useObservable(vm.mark.progress$) ?? null;
  const activePanel = useObservable(vm.browse.activePanel$) ?? null;
  const scrollToAnnotationId = useObservable(vm.browse.scrollToAnnotationId$) ?? null;
  const panelInitialTab = useObservable(vm.browse.panelInitialTab$) ?? null;
  const onScrollCompleted = vm.browse.onScrollCompleted;
  const generationProgress = useObservable(vm.yield.progress$) ?? null;
  const gatherContext = useObservable(vm.gather.context$) ?? null;
  const gatherLoading = useObservable(vm.gather.loading$) ?? false;
  const gatherError = useObservable(vm.gather.error$) ?? null;
  const wizardState = useObservable(vm.wizard$);
  const wizardOpen = wizardState?.open ?? false;
  const wizardAnnotationId = wizardState?.annotationId ?? null;
  const wizardResourceId = wizardState?.resourceId ?? null;
  const wizardDefaultTitle = wizardState?.defaultTitle ?? '';
  const wizardEntityTypes = wizardState?.entityTypes ?? [];

  const handleWizardClose = useCallback(() => {
    vm.closeWizard();
  }, [vm]);

  const handleWizardGenerateSubmit = useCallback((referenceId: string, config: GenerationConfig) => {
    clearNewAnnotationId(annotationId(referenceId));
    vm.yield.generate(referenceId, {
      title: config.title,
      storageUri: config.storagePath,
      prompt: config.prompt,
      language: config.language,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      context: config.context,
    });
  }, [vm, clearNewAnnotationId]);

  const handleWizardLinkResource = useCallback(async (referenceId: string, targetResourceId: string) => {
    if (!semiont) return;
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
    browser.emit('nav:push', {
      path: `/know/compose?${params.toString()}`,
      reason: 'compose-from-wizard',
    });
  }, [session]);

  // Add resource to open tabs when it loads
  useEffect(() => {
    if (resource && rUri) {
      const mediaType = getPrimaryMediaType(resource);
      browser.addOpenResource(rUri, resource.name, mediaType || undefined, resource.storageUri);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lastViewedDocumentId', rUri);
      }
    }
  }, [resource, rUri, browser]);

  // Bridge: when the mark VM produces a pending annotation, open the
  // annotations panel. The mark VM (session-scoped) can't emit `panel:open`
  // (app-scoped) directly — the React tree is the natural seam between
  // the two buses.
  useEffect(() => {
    if (pendingAnnotation) {
      browser.emit('panel:open', { panel: 'annotations' });
    }
  }, [pendingAnnotation, browser]);

  // Domain events flow through the bus gateway (ActorVM → local EventBus).
  // BrowseNamespace cache invalidation handles annotation/resource updates.
  // The resource-viewer-page-vm calls client.subscribeToResource(resourceId)
  // which bridges scoped domain events into the local EventBus.

  const handleResourceArchive = useCallback(async () => {
    if (!semiont) return;
    try {
      await semiont.mark.archive(rUri);
      await refetchDocument();
    } catch (err) {
      console.error('Failed to archive document:', err);
      showError('Failed to archive document');
    }
  }, [semiont, rUri, refetchDocument, showError]);

  const handleResourceUnarchive = useCallback(async () => {
    if (!semiont) return;
    try {
      await semiont.mark.unarchive(rUri);
      await refetchDocument();
    } catch (err) {
      console.error('Failed to unarchive document:', err);
      showError('Failed to unarchive document');
    }
  }, [semiont, rUri, refetchDocument, showError]);

  const handleResourceClone = useCallback(async () => {
    if (!semiont) return;
    try {
      const result = await semiont.generateCloneToken(rUri);
      const token = result.token;
      browser.emit('nav:push', { path: `/know/compose?mode=clone&token=${token}`, reason: 'clone' });
    } catch (err) {
      console.error('Failed to generate clone token:', err);
      showError('Failed to generate clone link');
    }
  }, [semiont, rUri, showError, session]);

  const handleAnnotationSparkle = useCallback(({ annotationId }: { annotationId: string }) => {
    triggerSparkleAnimation(annotationId);
  }, [triggerSparkleAnimation]);

  const handleAnnotationAdded = useCallback((stored: EventMap['mark:added']) => {
    triggerSparkleAnimation(stored.payload.annotation.id);
  }, [triggerSparkleAnimation]);

  const handleAnnotationCreateFailed = useCallback(({ message }: { message?: string }) =>
    showError(`Failed to create annotation: ${message || 'unknown error'}`), [showError]);
  const handleAnnotationDeleteFailed = useCallback(({ message }: { message?: string }) =>
    showError(`Failed to delete annotation: ${message || 'unknown error'}`), [showError]);
  const handleAnnotateBodyUpdated = useCallback(() => {
    // Success - optimistic update already applied via EventBus
  }, []);
  const handleAnnotateBodyUpdateFailed = useCallback(({ message }: { message: string }) =>
    showError(`Failed to update reference: ${message}`), [showError]);

  const handleSettingsThemeChanged = useCallback(({ theme }: { theme: any }) => setTheme(theme), [setTheme]);

  // Unified job lifecycle handlers. `job:complete` / `job:fail` fire
  // for every job type (annotation + generation); we dispatch on
  // jobType and filter to this resource. `annotationId` is present on
  // jobs attached to a specific annotation (today: generation from a
  // reference); it's what UI consumers lower down in the tree use to
  // attach per-annotation visual feedback.
  const handleJobComplete = useCallback((event: components['schemas']['JobCompleteCommand']) => {
    if (event.resourceId !== (resource.id as string)) return;
    if (event.jobType === 'generation') {
      const result = event.result as components['schemas']['JobGenerationResult'] | undefined;
      const name = result?.resourceName;
      showSuccess(name
        ? `Resource "${name}" created successfully!`
        : 'Resource created successfully!');
    } else {
      showSuccess('Annotation complete');
    }
  }, [resource.id, showSuccess]);
  const handleJobFailed = useCallback((event: components['schemas']['JobFailCommand']) => {
    if (event.resourceId !== (resource.id as string)) return;
    if (event.jobType === 'generation') {
      showError(`Resource generation failed: ${event.error}`);
    } else {
      showError(event.error || 'Annotation failed');
    }
  }, [resource.id, showError]);

  const handleReferenceNavigate = useCallback(({ resourceId }: { resourceId: string }) => {
    if (routes.resourceDetail) {
      const path = routes.resourceDetail(resourceId);
      browser.emit('nav:push', { path, reason: 'reference-link' });
    }
  }, [routes.resourceDetail, session]);

  const handleEntityTypeClicked = useCallback(({ entityType }: { entityType: string }) => {
    if (routes.know) {
      const path = `${routes.know}?entityType=${encodeURIComponent(entityType)}`;
      browser.emit('nav:push', { path, reason: 'entity-type-filter' });
    }
  }, [routes.know, session]);

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
    'job:complete': handleJobComplete,
    'job:fail': handleJobFailed,
    'mark:assist-cancelled': () => showInfo('Annotation cancelled'),
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


  // Combine resource with content
  const resourceWithContent = { ...resource, content };

  // Handlers for AnnotationHistory (legacy event-based interaction)
  const handleEventHover = useCallback((id: string | null) => {
    if (id) {
      session?.client.beckon.sparkle(annotationId(id));
    }
  }, [session]);

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
                  annotations={groups ?? { highlights: [], comments: [], assessments: [], references: [], tags: [] }}
                  generatingReferenceId={generationProgress?.annotationId ?? null}
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
                generatingReferenceId={generationProgress?.annotationId ?? null}
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
                state={streamStatus}
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
