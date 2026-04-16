"use client";

/**
 * Resource Viewer Page - Minimal Next.js routing wrapper
 *
 * Handles only Next.js routing and initial resource loading.
 * All other concerns (data loading, events, UI state) are handled by ResourceViewerPage.
 */

import { useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useLocale } from '@/i18n/routing';
import { useApiClient, useObservable, useViewModel, createResourceLoaderVM } from '@semiont/react-ui';
import { resourceId } from '@semiont/core';
import { Link, routes } from '@/lib/routing';
import { useStreamStatus } from '@/contexts/StreamStatusContext';

// Feature components
import { ResourceLoadingState, ResourceErrorState, ResourceViewerPage, useKnowledgeBaseSession } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import type { SemiontResource } from '@semiont/react-ui';

/**
 * Main page component - handles only routing and initial resource load
 */
export default function KnowledgeResourcePage() {
  const params = useParams();
  const locale = useLocale();

  // The URL param is the bare resource ID
  const rId = resourceId(params?.id as string);

  const streamStatus = useStreamStatus();
  const { activeKnowledgeBase } = useKnowledgeBaseSession();

  const semiont = useApiClient();
  const loader = useViewModel(() => createResourceLoaderVM(semiont!, rId));
  const resourceData = useObservable(loader.resource$);
  const isLoading = useObservable(loader.isLoading$) ?? true;

  // Log error for debugging
  useEffect(() => {
    if (!isLoading && !resourceData) {
      console.error(`[Document] Resource ${rId} not found`);
    }
  }, [isLoading, rId, resourceData]);

  const refetchDocument = useCallback(async () => {
    loader.invalidate();
  }, [loader]);

  // Early return: Loading state
  if (isLoading || !resourceData) {
    return <ResourceLoadingState />;
  }

  const resource = resourceData as SemiontResource;
  // resource['@id'] is now a bare ID
  const canonicalId = resourceId(resource['@id']);

  // Render with minimal props - all data loading/events handled inside ResourceViewerPage
  return (
    <ResourceViewerPage
      resource={resource}
      rUri={canonicalId}
      locale={locale}
      Link={Link}
      routes={routes}
      ToolbarPanels={ToolbarPanels}
      refetchDocument={refetchDocument}
      streamStatus={streamStatus}
      knowledgeBaseName={activeKnowledgeBase?.label}
    />
  );
}
