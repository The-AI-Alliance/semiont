"use client";

/**
 * Resource Viewer Page - Minimal Next.js routing wrapper
 *
 * Handles only Next.js routing and initial resource loading.
 * All other concerns (data loading, events, UI state) are handled by ResourceViewerPage.
 */

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useResources } from '@semiont/react-ui';
import type { ResourceUri } from '@semiont/api-client';
import { resourceUri } from '@semiont/api-client';
import { Link, routes } from '@/lib/routing';
import { useCacheManager } from '@/hooks/useCacheManager';

// Feature components
import { ResourceLoadingState, ResourceErrorState, ResourceViewerPage, TranslationProvider } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { SearchResourcesModal } from '@/components/modals/SearchResourcesModal';
import { GenerationConfigModal } from '@/components/modals/GenerationConfigModal';
import type { SemiontResource } from '@semiont/react-ui';

/**
 * Main page component - handles only routing and initial resource load
 */
export default function KnowledgeResourcePage() {
  const params = useParams();
  const locale = useLocale();
  const cacheManager = useCacheManager();

  // Construct resource URI from URL param
  const initialUri = resourceUri(`${typeof window !== 'undefined' ? window.location.origin : 'http://localhost'}/resources/${params?.id}`);

  // Load only the resource descriptor - everything else is loaded by ResourceViewerPage
  const resources = useResources();
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

  // Render with minimal props - all data loading/events handled inside ResourceViewerPage
  return (
    <TranslationProvider>
      <ResourceViewerPage
        resource={resource}
        rUri={canonicalUri}
        locale={locale}
        cacheManager={cacheManager}
        Link={Link}
        routes={routes}
        ToolbarPanels={ToolbarPanels}
        SearchResourcesModal={SearchResourcesModal}
        GenerationConfigModal={GenerationConfigModal}
        refetchDocument={refetchDocument}
      />
    </TranslationProvider>
  );
}
