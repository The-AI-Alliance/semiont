"use client";

import React, { useEffect, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/i18n/routing';
import { useRouter } from '@/i18n/routing';
import { useSearchParams } from 'react-router-dom';
import {
  useApiClient,
  useKnowledgeBaseSession,
  useToast,
  useTheme,
  useBrowseVM,
  useObservable,
  useLineNumbers,
  useHoverDelay,
  useEventSubscriptions,
  useViewModel,
  Toolbar,
  ComposeLoadingState,
  ResourceComposePage,
} from '@semiont/react-ui';
import type { SaveResourceParams as UISaveResourceParams } from '@semiont/react-ui';
import { createComposePageVM } from '@semiont/api-client';
import type { AccessToken } from '@semiont/core';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';

function ComposeResourceContent() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Compose.${k}`, p as any) as string;
  const locale = useLocale();
  const router = useRouter();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading: authLoading, token: authToken } = useKnowledgeBaseSession();
  const { showError, showSuccess } = useToast();
  const client = useApiClient();

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) router.push('/');
  }, [authLoading, isAuthenticated, router]);

  const browseVM = useBrowseVM();

  const contextKey = searchParams?.get('annotationUri')
    ? `gather-context:${searchParams.get('annotationUri')}`
    : null;
  const storedContext = contextKey && typeof sessionStorage !== 'undefined'
    ? sessionStorage.getItem(contextKey) ?? undefined
    : undefined;
  if (contextKey && storedContext && typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem(contextKey);
  }

  const vm = useViewModel(() => createComposePageVM(client, browseVM, {
    mode: searchParams?.get('mode') ?? undefined,
    token: searchParams?.get('token') ?? undefined,
    annotationUri: searchParams?.get('annotationUri') ?? undefined,
    sourceDocumentId: searchParams?.get('sourceDocumentId') ?? undefined,
    name: searchParams?.get('name') ?? undefined,
    entityTypes: searchParams?.get('entityTypes') ?? undefined,
    storedContext,
  }, authToken as AccessToken | undefined));

  const activePanel = useObservable(vm.browse.activePanel$) ?? null;
  const pageMode = useObservable(vm.mode$) ?? 'new';
  const isLoading = useObservable(vm.loading$) ?? true;
  const cloneData = useObservable(vm.cloneData$) ?? null;
  const referenceData = useObservable(vm.referenceData$) ?? null;
  const gatheredContext = useObservable(vm.gatheredContext$) ?? null;
  const availableEntityTypes = useObservable(vm.entityTypes$) ?? [];

  const { theme, setTheme, resolvedTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();
  const { hoverDelayMs } = useHoverDelay();

  useEventSubscriptions({
    'settings:theme-changed': ({ theme }: { theme: 'light' | 'dark' | 'system' }) => setTheme(theme),
    'settings:line-numbers-toggled': () => toggleLineNumbers(),
  });

  const handleSaveResource = async (params: UISaveResourceParams) => {
    try {
      const newResourceId = await vm.save(params);
      if (params.mode === 'reference' && params.annotationUri) {
        showSuccess('Reference successfully linked to the new resource');
      }
      router.push(`/know/resource/${encodeURIComponent(newResourceId)}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to save resource. Please try again.';
      showError(errorMessage);
      throw error;
    }
  };

  if (authLoading || isLoading) {
    return <ComposeLoadingState message={authLoading ? 'Checking authentication...' : 'Loading cloned resource...'} />;
  }

  if (!isAuthenticated) return null;

  return (
    <ResourceComposePage
      mode={pageMode}
      cloneData={cloneData}
      referenceData={referenceData}
      gatheredContext={gatheredContext}
      availableEntityTypes={availableEntityTypes}
      initialLocale={locale}
      theme={resolvedTheme}
      showLineNumbers={showLineNumbers}
      hoverDelayMs={hoverDelayMs}
      activePanel={activePanel}
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
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Compose.${k}`, p as any) as string;

  return (
    <Suspense fallback={<ComposeLoadingState message={t('loading')} />}>
      <ComposeResourceContent />
    </Suspense>
  );
}
