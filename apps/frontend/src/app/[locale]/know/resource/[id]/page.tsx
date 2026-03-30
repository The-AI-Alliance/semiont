"use client";

/**
 * Resource Viewer Page - Minimal Next.js routing wrapper
 *
 * Handles only Next.js routing and initial resource loading.
 * All other concerns (data loading, events, UI state) are handled by ResourceViewerPage.
 */

import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useLocale } from '@/i18n/routing';
import { useResources } from '@semiont/react-ui';
import { resourceId } from '@semiont/core';
import { Link, routes } from '@/lib/routing';

// Feature components
import { ResourceLoadingState, ResourceErrorState, ResourceViewerPage } from '@semiont/react-ui';
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

  // Load only the resource descriptor - everything else is loaded by ResourceViewerPage
  const resources = useResources();
  const {
    data: docData,
    isLoading,
    isError,
    error,
    refetch: refetchDocument
  } = resources.get.useQuery(rId) as {
    data: { resource: SemiontResource } | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => Promise<unknown>;
  };

  // Log error for debugging
  useEffect(() => {
    if (isError && !isLoading) {
      console.error(`[Document] Failed to load resource ${rId}:`, error);
    }
  }, [isError, isLoading, rId, error]);

  // Early return: Loading state
  if (isLoading || !docData) {
    return <ResourceLoadingState />;
  }

  // Early return: Error state
  if (isError) {
    return <ResourceErrorState error={error} onRetry={() => refetchDocument()} />;
  }

  // Early return: ResourceDescriptor not found
  if (!docData.resource) {
    return <ResourceErrorState error={new Error('Resource not found')} onRetry={() => refetchDocument()} />;
  }

  const resource = docData.resource;
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
    />
  );
}
