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
import { useSemiont, useObservable, useViewModel, createResourceLoaderVM } from '@semiont/react-ui';
import { resourceId } from '@semiont/core';
import { Link, routes } from '@/lib/routing';
import { useStreamStatus } from '@/contexts/StreamStatusContext';

// Feature components
import { ResourceLoadingState, ResourceErrorState, ResourceViewerPage, useKnowledgeBaseSession } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import type { SemiontResource } from '@semiont/react-ui';

/**
 * Main page component - handles only routing and initial resource load.
 *
 * The inner component is keyed on `rId` so that navigation between
 * resources (URL-param change without component unmount) forces a full
 * remount. Without this, `useViewModel`'s factory closes over the
 * initial `rId` and never re-runs, and the URL changes but the content
 * stays on the first-loaded resource.
 */
export default function KnowledgeResourcePage() {
  const params = useParams();
  const rId = resourceId(params?.id as string);
  return <KnowledgeResourcePageInner key={rId} rId={rId} />;
}

function KnowledgeResourcePageInner({ rId }: { rId: ReturnType<typeof resourceId> }) {
  const locale = useLocale();

  const streamStatus = useStreamStatus();
  const { activeKnowledgeBase } = useKnowledgeBaseSession();

  const semiont = useObservable(useSemiont().activeSession$)?.client;
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
