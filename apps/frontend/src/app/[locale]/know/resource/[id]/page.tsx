"use client";

/**
 * Resource Viewer Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (routing, data loading, hooks)
 * and delegates rendering to the pure React ResourceViewerPage component.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useResources, useEntityTypes, useApiClient, useAnnotations } from '@semiont/react-ui';
import { QUERY_KEYS } from '@semiont/react-ui';
import type { components, ResourceUri, ContentFormat } from '@semiont/api-client';
import { resourceUri, decodeWithCharset, getPrimaryMediaType, resourceAnnotationUri } from '@semiont/api-client';
import { useOpenResources, useResourceAnnotations } from '@semiont/react-ui';
import { useToast } from '@semiont/react-ui';
import { useTheme } from '@semiont/react-ui';
import { useToolbar } from '@semiont/react-ui';
import { useLineNumbers } from '@semiont/react-ui';
import { useResourceEvents } from '@semiont/react-ui';
import { useDebouncedCallback } from '@semiont/react-ui';
import { Link, routes } from '@/lib/routing';
import { useCacheManager } from '@/hooks/useCacheManager';

// Feature components
import { ResourceLoadingState, ResourceErrorState, ResourceViewerPage } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { SearchResourcesModal } from '@/components/modals/SearchResourcesModal';
import { GenerationConfigModal } from '@/components/modals/GenerationConfigModal';
import type { SemiontResource, Motivation } from '@semiont/react-ui';

/**
 * Main page component - handles data loading only
 */
export default function KnowledgeResourcePage() {
  const params = useParams();

  // Construct resource URI from URL param
  const initialUri = resourceUri(`${typeof window !== 'undefined' ? window.location.origin : 'http://localhost'}/resources/${params?.id}`);

  // API hooks
  const resources = useResources();
  const entityTypesAPI = useEntityTypes();
  const annotationsAPI = useAnnotations();

  // Load resource data
  const {
    data: docData,
    isLoading,
    isError,
    error,
    refetch: refetchDocument
  } = resources.get.useQuery(initialUri) as {
    data: { resource: SemiontResource } | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => Promise<unknown>;
  };

  // Log error for debugging
  useEffect(() => {
    if (isError && !isLoading) {
      console.error(`[Document] Failed to load resource ${initialUri}:`, error);
    }
  }, [isError, isLoading, initialUri, error]);

  // Early return: Loading state
  if (isLoading) {
    return <ResourceLoadingState />;
  }

  // Early return: Error state
  if (isError) {
    return <ResourceErrorState error={error} onRetry={() => refetchDocument()} />;
  }

  // Early return: ResourceDescriptor not found
  if (!docData?.resource) {
    return <ResourceErrorState error={new Error('Resource not found')} onRetry={() => refetchDocument()} />;
  }

  const resource = docData.resource;
  const canonicalUri = resourceUri(resource['@id']);

  // Warn if URI mismatch
  if (canonicalUri !== initialUri) {
    console.warn(
      `[Document] URI mismatch:\n` +
      `  Constructed: ${initialUri}\n` +
      `  Canonical:   ${canonicalUri}\n` +
      `This may indicate environment misconfiguration.`
    );
  }

  return (
    <ResourceViewWrapper
      resource={resource}
      rUri={canonicalUri}
      refetchDocument={refetchDocument}
      resources={resources}
      entityTypesAPI={entityTypesAPI}
      annotationsAPI={annotationsAPI}
    />
  );
}

/**
 * ResourceViewWrapper - Thin Next.js wrapper for ResourceViewerPage
 *
 * Reads Next.js hooks and passes everything as props to pure component.
 */
function ResourceViewWrapper({
  resource,
  rUri,
  refetchDocument,
  resources,
  entityTypesAPI,
  annotationsAPI
}: {
  resource: SemiontResource;
  rUri: ResourceUri;
  refetchDocument: () => Promise<unknown>;
  resources: ReturnType<typeof useResources>;
  entityTypesAPI: ReturnType<typeof useEntityTypes>;
  annotationsAPI: ReturnType<typeof useAnnotations>;
}) {
  const { data: session } = useSession();
  const locale = useLocale();
  const { addResource } = useOpenResources();
  const { triggerSparkleAnimation, clearNewAnnotationId, deleteAnnotation, createAnnotation } = useResourceAnnotations();
  const { showError, showSuccess } = useToast();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const cacheManager = useCacheManager();

  // Fetch document content separately
  const [content, setContent] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(true);

  useEffect(() => {
    const loadContent = async () => {
      if (!client) return;

      try {
        const mediaType = getPrimaryMediaType(resource) || 'text/plain';
        const { data } = await client.getResourceRepresentation(rUri as ResourceUri, {
          accept: mediaType as ContentFormat,
        });
        const text = decodeWithCharset(data, mediaType);
        setContent(text);
      } catch (error) {
        console.error('Failed to fetch representation:', error);
        showError('Failed to load resource representation');
      } finally {
        setContentLoading(false);
      }
    };
    loadContent();
  }, [rUri, resource, client, showError]);

  // Fetch all annotations with a single request
  const { data: annotationsData, refetch: refetchAnnotations } = resources.annotations.useQuery(rUri);
  const annotations = annotationsData?.annotations || [];

  // Create debounced invalidation for real-time events (batches rapid updates)
  const debouncedInvalidateAnnotations = useDebouncedCallback(
    () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(rUri) });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(rUri) });
    },
    500
  );

  const { data: referencedByData, isLoading: referencedByLoading } = resources.referencedBy.useQuery(rUri);
  const referencedBy = referencedByData?.referencedBy || [];

  // Get entity types for detection
  const { data: entityTypesData } = entityTypesAPI.list.useQuery();
  const allEntityTypes = (entityTypesData as { entityTypes: string[] } | undefined)?.entityTypes || [];

  // Set up mutations
  const updateDocMutation = resources.update.useMutation();
  const updateAnnotationBodyMutation = annotationsAPI.updateBody.useMutation();
  const generateCloneTokenMutation = resources.generateCloneToken.useMutation();

  const { theme, setTheme } = useTheme();
  const { activePanel, togglePanel, setActivePanel } = useToolbar({ persistToStorage: true });
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // Add resource to open tabs when it loads
  useEffect(() => {
    if (resource && rUri) {
      const resourceIdSegment = rUri.split('/').pop() || '';
      const mediaType = getPrimaryMediaType(resource);
      addResource(resourceIdSegment, resource.name, mediaType || undefined);
      localStorage.setItem('lastViewedDocumentId', resourceIdSegment);
    }
  }, [resource, rUri, addResource]);

  // Update document tags
  const handleUpdateDocumentTags = useCallback(async (tags: string[]) => {
    try {
      await updateDocMutation.mutateAsync({
        rUri,
        data: { entityTypes: tags }
      });
      showSuccess('Document tags updated successfully');
      await refetchDocument();
    } catch (err) {
      console.error('Failed to update document tags:', err);
      showError('Failed to update document tags');
    }
  }, [rUri, updateDocMutation, refetchDocument, showSuccess, showError]);

  // Handle archive toggle
  const handleArchive = useCallback(async () => {
    if (!resource) return;

    try {
      await updateDocMutation.mutateAsync({
        rUri,
        data: { archived: true }
      });
      await refetchDocument();
      showSuccess('Document archived');
    } catch (err) {
      console.error('Failed to archive document:', err);
      showError('Failed to archive document');
    }
  }, [resource, rUri, updateDocMutation, refetchDocument, showSuccess, showError]);

  const handleUnarchive = useCallback(async () => {
    if (!resource) return;

    try {
      await updateDocMutation.mutateAsync({
        rUri,
        data: { archived: false }
      });
      await refetchDocument();
      showSuccess('Document unarchived');
    } catch (err) {
      console.error('Failed to unarchive document:', err);
      showError('Failed to unarchive document');
    }
  }, [resource, rUri, updateDocMutation, refetchDocument, showSuccess, showError]);

  // Handle clone
  const handleClone = useCallback(async () => {
    if (!resource) return;

    try {
      const result = await generateCloneTokenMutation.mutateAsync(rUri);
      const token = result.token;
      const cloneUrl = `${window.location.origin}/know/clone?token=${token}`;

      await navigator.clipboard.writeText(cloneUrl);
      showSuccess('Clone link copied to clipboard');
    } catch (err) {
      console.error('Failed to generate clone token:', err);
      showError('Failed to generate clone link');
    }
  }, [resource, rUri, generateCloneTokenMutation, showSuccess, showError]);

  // Handle annotation body updates
  const handleUpdateAnnotationBody = useCallback(async (annotationUri: string, data: any) => {
    await updateAnnotationBodyMutation.mutateAsync({
      annotationUri: resourceAnnotationUri(annotationUri),
      data,
    });
  }, [updateAnnotationBodyMutation]);

  // Real-time document events
  const { status: eventStreamStatus, isConnected, eventCount, lastEvent } = useResourceEvents({
    rUri,
    autoConnect: true,

    // Annotation events - use debounced invalidation to batch rapid updates
    onAnnotationAdded: useCallback((event) => {
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    onAnnotationRemoved: useCallback((event) => {
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    onAnnotationBodyUpdated: useCallback((event) => {
      // Optimistically update annotations cache with body operations
      queryClient.setQueryData(QUERY_KEYS.documents.annotations(rUri), (old: any) => {
        if (!old) return old;
        return {
          ...old,
          annotations: old.annotations.map((annotation: any) => {
            const annotationIdSegment = annotation.id.split('/').pop();
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

      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(rUri) });
    }, [queryClient, rUri]),

    // Document status events
    onDocumentArchived: useCallback((event) => {
      refetchDocument();
      showSuccess('This document has been archived');
      debouncedInvalidateAnnotations();
    }, [refetchDocument, showSuccess, debouncedInvalidateAnnotations]),

    onDocumentUnarchived: useCallback((event) => {
      refetchDocument();
      showSuccess('This document has been unarchived');
      debouncedInvalidateAnnotations();
    }, [refetchDocument, showSuccess, debouncedInvalidateAnnotations]),

    // Entity tag events
    onEntityTagAdded: useCallback((event) => {
      refetchDocument();
      debouncedInvalidateAnnotations();
    }, [refetchDocument, debouncedInvalidateAnnotations]),

    onEntityTagRemoved: useCallback((event) => {
      refetchDocument();
      debouncedInvalidateAnnotations();
    }, [refetchDocument, debouncedInvalidateAnnotations]),

    onError: useCallback((error) => {
      console.error('[RealTime] Event stream error:', error);
    }, []),
  });

  // Render the pure component with all props
  return (
    <ResourceViewerPage
      resource={resource}
      rUri={rUri}
      content={content}
      contentLoading={contentLoading}
      annotations={annotations}
      referencedBy={referencedBy}
      referencedByLoading={referencedByLoading}
      allEntityTypes={allEntityTypes}
      locale={locale}
      theme={theme}
      onThemeChange={setTheme}
      showLineNumbers={showLineNumbers}
      onLineNumbersToggle={toggleLineNumbers}
      activePanel={activePanel}
      onPanelToggle={togglePanel}
      setActivePanel={setActivePanel}
      onUpdateDocumentTags={handleUpdateDocumentTags}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onClone={handleClone}
      onUpdateAnnotationBody={handleUpdateAnnotationBody}
      onRefetchAnnotations={async () => { await refetchAnnotations(); }}
      onCreateAnnotation={async (rUri, motivation, selector, body) => {
        await createAnnotation(rUri, motivation as any, selector, body);
      }}
      onDeleteAnnotation={async (annotationId) => {
        await deleteAnnotation(annotationId, rUri);
      }}
      onTriggerSparkleAnimation={(annotationId) => {
        triggerSparkleAnimation(annotationId as any);
      }}
      onClearNewAnnotationId={(annotationId) => {
        clearNewAnnotationId(annotationId as any);
      }}
      showSuccess={showSuccess}
      showError={showError}
      onAnnotationAdded={(event) => debouncedInvalidateAnnotations()}
      onAnnotationRemoved={(event) => debouncedInvalidateAnnotations()}
      onAnnotationBodyUpdated={(event) => {}}
      onDocumentArchived={(event) => {}}
      onDocumentUnarchived={(event) => {}}
      onEntityTagAdded={(event) => {}}
      onEntityTagRemoved={(event) => {}}
      onEventError={(error) => {}}
      cacheManager={cacheManager}
      client={client}
      Link={Link}
      routes={routes}
      ToolbarPanels={ToolbarPanels}
      SearchResourcesModal={SearchResourcesModal}
      GenerationConfigModal={GenerationConfigModal}
    />
  );
}
