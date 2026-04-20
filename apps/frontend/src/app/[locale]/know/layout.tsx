import { useContext, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';
import {
  Footer,
  ResourceAnnotationsProvider,
  OpenResourcesProvider,
  ApiClientProvider,
  Toolbar,
  useSemiont,
  useBrowseVM,
  useObservable,
  useTheme,
  useLineNumbers,
  kbBackendUrl,
  getKbSessionStatus,
} from '@semiont/react-ui';
import type { ConnectionState } from '@semiont/api-client';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link, routes } from '@/lib/routing';
import { useOpenResourcesManager } from '@/hooks/useOpenResourcesManager';
import { StreamStatusContext } from '@/contexts/StreamStatusContext';
import { AuthShell } from '@/contexts/AuthShell';

function GlobalEventsConnector() {
  return null;
}

/**
 * Empty state for the main content area when no KB is connected or authenticated.
 * Shows contextual guidance based on whether any KBs exist.
 */
function DiscoverEmptyState() {
  const { t: _t } = useTranslation();
  const t = (k: string) => _t(`DiscoverEmptyState.${k}`) as string;
  const semiont = useSemiont();
  const knowledgeBases = useObservable(semiont.kbs$) ?? [];
  const activeKnowledgeBase = useObservable(semiont.activeSession$)?.kb ?? null;
  const status = activeKnowledgeBase
    ? getKbSessionStatus(activeKnowledgeBase.id)
    : null;

  if (knowledgeBases.length === 0) {
    return (
      <div style={{ textAlign: 'center', maxWidth: '28rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>{t('noKnowledgeBases')}</h2>
        <p style={{ color: 'var(--semiont-color-neutral-400)', fontSize: '0.85rem', lineHeight: 1.5, marginBottom: '0.75rem' }}>
          {t('noKnowledgeBasesHint')}
        </p>
        <p style={{ color: 'var(--semiont-color-neutral-400)', fontSize: '0.85rem', lineHeight: 1.5 }}>
          <a href="https://github.com/The-AI-Alliance/semiont" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--semiont-color-primary-500)' }}>{t('findKnowledgeBases')}</a>
          {' · '}
          <a href="https://github.com/The-AI-Alliance/semiont-template-kb" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--semiont-color-primary-500)' }}>{t('createNew')}</a>
        </p>
      </div>
    );
  }

  if (status === 'authenticated') {
    return null;
  }

  return (
    <div style={{ textAlign: 'center', maxWidth: '24rem' }}>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
        {activeKnowledgeBase?.label ?? ''}
      </h2>
      <p style={{ color: 'var(--semiont-color-neutral-400)', fontSize: '0.85rem', lineHeight: 1.5 }}>
        {status === 'expired' ? t('sessionExpired') : t('signedOut')}
        {' '}{t('signInHint')}
      </p>
    </div>
  );
}

function UnauthenticatedKnowledgeLayout({ t, keyboardContext }: { t: (key: string, params?: Record<string, unknown>) => string; keyboardContext: { openKeyboardHelp?: () => void } | null }) {
  const browseVM = useBrowseVM();
  const activePanel = useObservable(browseVM.activePanel$) ?? null;
  const { theme } = useTheme();
  const { showLineNumbers } = useLineNumbers();

  return (
    <div className="h-screen semiont-knowledge-layout semiont-layout-with-footer flex flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 w-full px-2 pb-6 flex flex-col overflow-hidden">
          <div className="w-full mx-auto flex-1 flex flex-col h-full overflow-hidden items-center justify-center">
            <DiscoverEmptyState />
          </div>
        </main>
        <ToolbarPanels
          activePanel={activePanel}
          showLineNumbers={showLineNumbers}
          theme={theme}
          hoverDelayMs={150}
        />
        <Toolbar activePanel={activePanel} context="simple" />
      </div>
      <Footer
        Link={Link}
        routes={routes}
        t={(key: string, params?: Record<string, unknown>) => t(`Footer.${key}`, params as any) as string}
        CookiePreferences={CookiePreferences}
        showPolicyLinks={!('__TAURI_INTERNALS__' in window)}
        {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      />
    </div>
  );
}

/**
 * Drives `StreamStatusContext` from the api-client's `actor.state$`
 * observable so downstream consumers (CollaborationPanel, future
 * reconnecting banner, tests) see the full six-state machine rather
 * than a collapsed boolean or tri-state summary.
 *
 * Mounts inside `SemiontProvider` so `useSemiont()` resolves.
 */
function KnowledgeLayoutInner({ children }: { children: React.ReactNode }) {
  const client = useObservable(useSemiont().activeSession$)?.client;
  const [state, setState] = useState<ConnectionState>('initial');

  useEffect(() => {
    if (!client) return;
    const sub = client.actor.state$.subscribe((next) => setState(next));
    return () => sub.unsubscribe();
  }, [client]);

  return (
    <StreamStatusContext.Provider value={state}>
      {children}
    </StreamStatusContext.Provider>
  );
}

function KnowledgeLayoutBody() {
  const { t } = useTranslation();
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const openResourcesManager = useOpenResourcesManager();
  const semiont = useSemiont();
  const activeKbId = useObservable(semiont.activeKbId$);
  const session = useObservable(semiont.activeSession$);
  const token = useObservable(session?.token$);
  const activeKnowledgeBase = session?.kb ?? null;
  // "Loading" = we intend to have a session (activeKbId is set) but the
  // session hasn't finished constructing yet.
  const isLoading = activeKbId != null && session == null;
  const refreshActive = async (): Promise<string | null> => (await session?.refresh()) ?? null;

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (!activeKnowledgeBase || !token) {
    return (
      <UnauthenticatedKnowledgeLayout t={(key: string, params?: Record<string, unknown>) => t(key, params as any) as string} keyboardContext={keyboardContext} />
    );
  }

  return (
    <ApiClientProvider baseUrl={kbBackendUrl(activeKnowledgeBase)} tokenRefresher={refreshActive}>
      <OpenResourcesProvider openResourcesManager={openResourcesManager}>
        <ResourceAnnotationsProvider>
          <GlobalEventsConnector />
          <KnowledgeLayoutInner>
            <div className="h-screen semiont-knowledge-layout semiont-layout-with-footer flex flex-col overflow-hidden">
              <div className="flex flex-1 overflow-hidden">
                <KnowledgeSidebarWrapper />
                <main className="flex-1 w-full px-2 pb-6 flex flex-col overflow-hidden">
                  <div className="w-full mx-auto flex-1 flex flex-col h-full overflow-hidden">
                    <Outlet />
                  </div>
                </main>
              </div>
              <Footer
                Link={Link}
                routes={routes}
                t={(key: string, params?: Record<string, unknown>) => t(`Footer.${key}`, params as any) as string}
                CookiePreferences={CookiePreferences}
                showPolicyLinks={!('__TAURI_INTERNALS__' in window)}
                {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
              />
            </div>
          </KnowledgeLayoutInner>
        </ResourceAnnotationsProvider>
      </OpenResourcesProvider>
    </ApiClientProvider>
  );
}

export default function KnowledgeLayout() {
  return (
    <AuthShell>
      <KnowledgeLayoutBody />
    </AuthShell>
  );
}
