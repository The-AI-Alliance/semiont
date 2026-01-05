"use client";

/**
 * Resource Compose Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (routing, auth, data loading, hooks)
 * and delegates rendering to the pure React ResourceComposePage component.
 */

import React, { useState, useEffect, Suspense } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useResources, useAnnotations, useEntityTypes, useApiClient } from '@semiont/react-ui';
import { useToast } from '@semiont/react-ui';
import { useTheme } from '@semiont/react-ui';
import { useToolbar } from '@semiont/react-ui';
import { useLineNumbers } from '@semiont/react-ui';
import { Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { getPrimaryMediaType, getResourceId, resourceUri, resourceAnnotationUri, type ResourceUri, type ContentFormat } from '@semiont/api-client';
import { decodeWithCharset } from '@semiont/api-client';
import { ComposeLoadingState } from '@/features/resource-compose/components/ComposeLoadingState';
import { ResourceComposePage } from '@/features/resource-compose/components/ResourceComposePage';
import type { SaveResourceParams } from '@/features/resource-compose/components/ResourceComposePage';

function ComposeResourceContent() {
  const t = useTranslations('Compose');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const { showError, showSuccess } = useToast();
  const mode = searchParams?.get('mode');
  const tokenFromUrl = searchParams?.get('token');

  // Authentication guard - redirect to home if not authenticated
  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.backendToken) {
      router.push('/');
    }
  }, [session, status, router]);

  // Reference completion parameters
  const referenceId = searchParams?.get('referenceId');
  const sourceDocumentId = searchParams?.get('sourceDocumentId');
  const nameFromUrl = searchParams?.get('name');
  const entityTypesFromUrl = searchParams?.get('entityTypes');

  const [isLoading, setIsLoading] = useState(true);
  const [cloneData, setCloneData] = useState<any>(null);
  const [referenceData, setReferenceData] = useState<any>(null);

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const handlePanelToggle = (panel: string | null) => {
    if (panel) togglePanel(panel as any);
  };

  // Convert theme to actual applied theme (system -> light or dark)
  const appliedTheme: 'light' | 'dark' = theme === 'system'
    ? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;

  // API hooks
  const resources = useResources();
  const annotations = useAnnotations();
  const entityTypesAPI = useEntityTypes();
  const client = useApiClient();

  // Fetch available entity types
  const { data: entityTypesData } = entityTypesAPI.list.useQuery();
  const availableEntityTypes = (entityTypesData as { entityTypes: string[] } | undefined)?.entityTypes || [];

  // Set up mutation hooks
  const createResourceMutation = resources.create.useMutation();
  const updateAnnotationBodyMutation = annotations.updateBody.useMutation();

  // Fetch cloned resource data if in clone mode
  const { data: cloneDataResponse } = resources.getByToken.useQuery(tokenFromUrl || '');
  const createFromTokenMutation = resources.createFromToken.useMutation();

  // Determine mode
  const isReferenceMode = Boolean(referenceId && sourceDocumentId && nameFromUrl);
  const isCloneMode = mode === 'clone' && Boolean(tokenFromUrl);
  const pageMode = isCloneMode ? 'clone' : isReferenceMode ? 'reference' : 'new';

  // Load cloned resource data or reference completion data
  useEffect(() => {
    const loadInitialData = async () => {
      // Handle reference completion mode
      if (isReferenceMode) {
        const entityTypes = entityTypesFromUrl ? entityTypesFromUrl.split(',') : [];
        setReferenceData({
          referenceId: referenceId!,
          sourceDocumentId: sourceDocumentId!,
          name: nameFromUrl!,
          entityTypes,
        });
        setIsLoading(false);
        return;
      }

      // Handle clone mode
      if (isCloneMode && cloneDataResponse) {
        if (cloneDataResponse.sourceResource && client) {
          try {
            const rUri = resourceUri(cloneDataResponse.sourceResource['@id']);
            const mediaType = getPrimaryMediaType(cloneDataResponse.sourceResource) || 'text/plain';
            const { data } = await client.getResourceRepresentation(rUri as ResourceUri, {
              accept: mediaType as ContentFormat,
            });
            const content = decodeWithCharset(data, mediaType);

            setCloneData({
              sourceResource: cloneDataResponse.sourceResource,
              sourceContent: content,
            });
          } catch (error) {
            console.error('Failed to fetch representation:', error);
            showError('Failed to load resource representation');
          }
        } else {
          showError('Invalid or expired clone token');
          router.push('/know/discover');
        }
        setIsLoading(false);
      } else if (isCloneMode && !tokenFromUrl) {
        showError('Clone token not found. Please try cloning again.');
        router.push('/know/discover');
      } else {
        setIsLoading(false);
      }
    };

    loadInitialData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tokenFromUrl, cloneDataResponse, referenceId, sourceDocumentId, nameFromUrl, entityTypesFromUrl, session?.backendToken]);

  // Handle save resource
  const handleSaveResource = async (params: SaveResourceParams) => {
    try {
      let rUri: ResourceUri;

      if (params.mode === 'clone') {
        // Create resource from clone token with edited content
        const response = await createFromTokenMutation.mutateAsync({
          token: tokenFromUrl!,
          name: params.name,
          content: params.content!,
          archiveOriginal: params.archiveOriginal || true,
        });

        if (!response.resource?.['@id']) {
          throw new Error('No resource URI returned from server');
        }
        rUri = resourceUri(response.resource['@id']);
      } else {
        // Create a new resource with entity types
        let fileToUpload: File;
        let mimeType: string;

        if (params.file) {
          fileToUpload = params.file;
          mimeType = params.format ?? 'application/octet-stream';
        } else {
          const blob = new Blob([params.content || ''], { type: params.format ?? 'application/octet-stream' });
          const extension = params.format === 'text/plain' ? '.txt' : params.format === 'text/html' ? '.html' : '.md';
          fileToUpload = new File([blob], params.name + extension, { type: params.format ?? 'application/octet-stream' });
          mimeType = params.format ?? 'application/octet-stream';
        }

        const format = params.charset && !params.file ? `${mimeType}; charset=${params.charset}` : mimeType;

        const response = await createResourceMutation.mutateAsync({
          name: params.name,
          file: fileToUpload,
          format,
          entityTypes: params.entityTypes || [],
          language: params.language,
          creationMethod: 'ui',
        });

        if (!response.resource?.['@id']) {
          throw new Error('No resource URI returned from server');
        }
        rUri = resourceUri(response.resource['@id']);

        // If this is a reference completion, update the reference
        if (params.mode === 'reference' && params.referenceId && params.sourceDocumentId) {
          try {
            const annotationUri = resourceAnnotationUri(`${params.sourceDocumentId}/annotations/${params.referenceId}`);
            await updateAnnotationBodyMutation.mutateAsync({
              annotationUri,
              data: {
                resourceId: params.sourceDocumentId,
                operations: [{
                  op: 'add',
                  item: {
                    type: 'SpecificResource',
                    source: rUri,
                    purpose: 'linking',
                  },
                }],
              },
            });
            showSuccess('Reference successfully linked to the new resource');
          } catch (error) {
            console.error('Failed to update reference:', error);
            showError('Resource created but failed to update reference. You may need to manually link it.');
          }
        }
      }

      // Navigate to the new resource
      const resourceId = getResourceId({ '@id': rUri } as any);
      if (!resourceId) {
        throw new Error('Failed to extract resource ID from URI');
      }
      router.push(`/know/resource/${encodeURIComponent(resourceId)}`);
    } catch (error) {
      console.error('Failed to save resource:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to save resource. Please try again.';
      showError(errorMessage);
      throw error;
    }
  };

  // Show loading state
  if (status === 'loading' || isLoading) {
    return (
      <ComposeLoadingState
        message={status === 'loading' ? 'Checking authentication...' : 'Loading cloned resource...'}
      />
    );
  }

  // Don't render if not authenticated
  if (!session?.backendToken) {
    return null;
  }

  // Render the pure component
  return (
    <ResourceComposePage
      mode={pageMode}
      cloneData={cloneData}
      referenceData={referenceData}
      availableEntityTypes={availableEntityTypes}
      initialLocale={locale}
      theme={appliedTheme}
      onThemeChange={setTheme}
      showLineNumbers={showLineNumbers}
      onLineNumbersToggle={toggleLineNumbers}
      activePanel={activePanel}
      onPanelToggle={handlePanelToggle}
      onSaveResource={handleSaveResource}
      onCancel={() => router.push('/know/discover')}
      translations={{
        title: t('title'),
        titleEditClone: t('titleEditClone'),
        titleCompleteReference: t('titleCompleteReference'),
        subtitleClone: t('subtitleClone'),
        subtitleReference: t('subtitleReference'),
        linkedNoticePrefix: t('linkedNoticePrefix'),
        resourceName: t('resourceName'),
        resourceNamePlaceholder: t('resourceNamePlaceholder'),
        entityTypes: t('entityTypes'),
        language: t('language'),
        contentSource: t('contentSource'),
        uploadFile: t('uploadFile'),
        uploadFileDescription: t('uploadFileDescription'),
        writeContent: t('writeContent'),
        writeContentDescription: t('writeContentDescription'),
        dropFileOrClick: t('dropFileOrClick'),
        supportedFormats: t('supportedFormats'),
        mediaType: t('mediaType'),
        autoDetected: t('autoDetected'),
        format: t('format'),
        content: t('content'),
        resourceContent: t('resourceContent'),
        encoding: t('encoding'),
        archiveOriginal: t('archiveOriginal'),
        cancel: t('cancel'),
        saving: t('saving'),
        creating: t('creating'),
        creatingAndLinking: t('creatingAndLinking'),
        saveClonedResource: t('saveClonedResource'),
        createAndLinkResource: t('createAndLinkResource'),
        createResource: t('createResource'),
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}

export default function ComposeResourcePage() {
  const t = useTranslations('Compose');

  return (
    <Suspense fallback={<ComposeLoadingState message={t('loading')} />}>
      <ComposeResourceContent />
    </Suspense>
  );
}
