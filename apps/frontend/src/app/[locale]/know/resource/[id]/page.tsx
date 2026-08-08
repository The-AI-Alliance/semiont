"use client";

/**
 * Resource Viewer Page - Minimal Next.js routing wrapper
 *
 * Handles only Next.js routing and initial resource loading.
 * All other concerns (data loading, events, UI state) are handled by ResourceViewerPage.
 */

import { useEffect, useCallback } from 'react';
import { useParams } from 'react-router';
import { useLocale } from '@/i18n/routing';
import { useSemiont, useObservable, useSessionStateUnit, createResourceLoaderStateUnit } from '@semiont/react-ui';
import { resourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { Link, routes } from '@/lib/routing';

// Feature components
import { ResourceLoadingState, ResourceErrorState, ResourceViewerPage } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import NotFound from '../../../not-found';
import type { SemiontResource } from '@semiont/react-ui';

/**
 * Main page component — routing, session gating, and initial resource load.
 *
 * `useSessionStateUnit` runs its factory exactly once per mount, and React Router
 * keeps this component mounted across BOTH a `:id` param change and an
 * `activeSession$` swap. So the inner component is keyed on the pair
 * `${session.id}:${rId}` — either changing forces a full remount:
 *
 *  - `rId` — otherwise the URL changes and the content stays on the
 *    first-loaded resource (tab-to-tab navigation in the left nav).
 *  - `session.id` — otherwise the loader keeps a DISPOSED client after a KB
 *    switch or a re-authentication, and a disposed cache is inert by B16:
 *    no fetch, no emission, "Loading resource..." forever. `kb.id` is not
 *    enough here; `signIn` rebuilds the session under an unchanged `kb.id`.
 *    See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
 *
 * Rendering is gated on a live session, so the inner component receives a
 * real one as a prop and can never read a session other than the one it is
 * keyed on.
 */
export default function KnowledgeResourcePage() {
  const params = useParams<{ id: string }>();
  const session = useObservable(useSemiont().activeSession$) ?? null;

  // `App.tsx` declares this route as `resource/:id`, so React Router cannot
  // match it without the param. That used to be written `params?.id as string`
  // — an assertion, which reads as harmless precisely because it is usually
  // true. It is not harmless: `resourceId()` takes a `string` and calls
  // `.includes('/')` on it immediately, so the one time the assumption broke
  // (a route-pattern rename) the page would throw a TypeError and white-screen
  // rather than degrade. Branching lets the compiler prove `id` is a string,
  // and turns that rename into a visible not-found.
  const id = params.id;
  if (!id) return <NotFound />;

  // Leaving a resource route on a KB switch is the SWITCH INITIATOR's job
  // (`KnowledgeBasePanel`), not this page's. A latch here cannot work:
  // `KnowledgeLayout` gates `<Outlet />` on a live session, so this component
  // is unmounted the instant `activeSession$` goes null and remounts fresh
  // against the new KB — it never observes the transition it would need to
  // detect. A previous attempt did exactly that and was dead in production
  // while its unit test (which renders this page WITHOUT the layout) passed.
  // See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
  if (!session) return <ResourceLoadingState />;

  const rId = resourceId(id);
  return <KnowledgeResourcePageInner key={`${session.id}:${rId}`} session={session} rId={rId} />;
}

function KnowledgeResourcePageInner({
  session,
  rId,
}: {
  session: SemiontSession;
  rId: ReturnType<typeof resourceId>;
}) {
  const locale = useLocale();

  const streamStatus = useObservable(session.streamState$) ?? 'initial';
  const activeKnowledgeBase = session.kb;

  const loader = useSessionStateUnit(session, (s) => createResourceLoaderStateUnit(s, rId));
  const resourceData = useObservable(loader?.resource$);
  const isLoading = useObservable(loader?.isLoading$) ?? true;
  const loadError = useObservable(loader?.error$) ?? null;

  // Log error for debugging
  useEffect(() => {
    if (loadError) {
      console.error(`[Document] Resource ${rId} failed to load:`, loadError.message);
    } else if (!isLoading && !resourceData) {
      console.error(`[Document] Resource ${rId} not found`);
    }
  }, [isLoading, loadError, rId, resourceData]);

  const refetchDocument = useCallback(async () => {
    loader?.invalidate();
  }, [loader]);

  // Early return: a terminal failure carries the reason, so it beats both the
  // spinner and the generic not-found. Without this branch the load is stuck
  // in "loading" forever — a failed key has no value either.
  if (loadError) {
    return <ResourceErrorState error={loadError} onRetry={refetchDocument} />;
  }
  if (isLoading) {
    return <ResourceLoadingState />;
  }
  if (!resourceData) {
    return <ResourceErrorState error={new Error(`Resource ${rId} not found`)} onRetry={refetchDocument} />;
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
      knowledgeBaseName={activeKnowledgeBase.label}
    />
  );
}
