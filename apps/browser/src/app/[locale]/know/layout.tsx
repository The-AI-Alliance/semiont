import { useEffect, useRef } from 'react';
import { Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';
import {
  ResourceAnnotationsProvider,
  Toolbar,
  useSemiont,
  useShellStateUnit,
  useObservable,
  useTheme,
  useKBDiscovery,
} from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useKbPanelOnLogin } from '@/hooks/useKbPanelOnLogin';

function GlobalEventsConnector() {
  return null;
}

/**
 * Empty state for the main content area when no KB is connected or authenticated.
 * Shows contextual guidance based on whether any KBs exist.
 */
export function DiscoverEmptyState() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) =>
    (p !== undefined ? _t(`DiscoverEmptyState.${k}`, p) : _t(`DiscoverEmptyState.${k}`)) as string;
  const semiont = useSemiont();
  const knowledgeBases = useObservable(semiont.kbs$) ?? [];
  // Launcher discovery: with zero registered KBs, say what's running on this
  // machine instead of only linking docs (BROWSER-KB-DISCOVERY follow-up).
  const { kbs: discoveredKbs } = useKBDiscovery();
  const activeKnowledgeBase = useObservable(semiont.activeSession$)?.kb ?? null;
  const status = activeKnowledgeBase
    ? semiont.getKbSessionStatus(activeKnowledgeBase.id)
    : null;

  if (knowledgeBases.length === 0) {
    return (
      <div style={{ textAlign: 'center', maxWidth: '28rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>{t('noKnowledgeBases')}</h2>
        <p style={{ color: 'var(--semiont-color-neutral-400)', fontSize: '0.85rem', lineHeight: 1.5, marginBottom: '0.75rem' }}>
          {t('noKnowledgeBasesHint')}
        </p>
        {discoveredKbs.length > 0 && (
          <p style={{ color: 'var(--semiont-color-primary-500)', fontSize: '0.85rem', lineHeight: 1.5, marginBottom: '0.75rem' }}>
            {t('discoveredOnMachine', { count: discoveredKbs.length })}
          </p>
        )}
        <p style={{ color: 'var(--semiont-color-neutral-400)', fontSize: '0.85rem', lineHeight: 1.5 }}>
          <a href="https://github.com/The-AI-Alliance/semiont/blob/main/docs/KNOWLEDGE-BASES.md" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--semiont-color-primary-500)' }}>{t('findKnowledgeBases')}</a>
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

function UnauthenticatedKnowledgeLayout() {
  const browseStateUnit = useShellStateUnit();
  const activePanel = useObservable(browseStateUnit.activePanel$) ?? null;
  const { theme } = useTheme();

  // Signed out, only two panels are viable: Knowledge Base (the way forward)
  // and Settings (works without a session). Everything else a previous visit
  // persisted is a dead end here — Account renders a "sign in first" notice,
  // and a RESOURCE panel (annotations/info/history/…) renders NOTHING at all:
  // ToolbarPanels hides its container for non-common panels, which left the
  // shell panel-less while its own message said to use the Knowledge Base
  // panel. Redirect every non-viable panel to the one we are pointing at.
  // Decided once, not reactively: a deliberate click on Account while signed
  // out should still show its message, not snap away.
  const panelCorrected = useRef(false);
  useEffect(() => {
    // useObservable yields null on the first render, before the BehaviorSubject's
    // current value arrives. Spending the one-shot on that null would let the
    // restored panel through on the render that actually carries it. (A true
    // "no panel" cannot reach this mount: readPanel() defaults to
    // knowledge-base when nothing is persisted.)
    if (panelCorrected.current || activePanel === null) return;
    panelCorrected.current = true;
    if (activePanel !== 'knowledge-base' && activePanel !== 'settings') {
      browseStateUnit.openPanel('knowledge-base');
    }
  }, [activePanel, browseStateUnit]);

  return (
    <div className="h-screen semiont-knowledge-layout flex flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 w-full px-2 pb-6 flex flex-col overflow-hidden">
          <div className="w-full mx-auto flex-1 flex flex-col h-full overflow-hidden items-center justify-center">
            <DiscoverEmptyState />
          </div>
        </main>
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
        />
        <Toolbar activePanel={activePanel} context="simple" />
      </div>
    </div>
  );
}

function KnowledgeLayoutBody() {
  const semiont = useSemiont();
  const activeKbId = useObservable(semiont.activeKbId$);
  const session = useObservable(semiont.activeSession$);
  const sessionActivating = useObservable(semiont.sessionActivating$);
  const token = useObservable(session?.token$);
  const activeKnowledgeBase = session?.kb ?? null;
  // "Loading" = a session construction is actively in flight. Without
  // the `sessionActivating` guard we'd sit on the spinner forever after
  // any `signOut`, which also leaves `activeKbId` set but `session`
  // null.
  const isLoading = activeKbId != null && session == null && sessionActivating;

  // A session that has just become live — restored at launch or signed in just
  // now — opens the Knowledge Base panel, whatever panel was showing before.
  useKbPanelOnLogin(Boolean(activeKnowledgeBase && token), semiont);

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
      <UnauthenticatedKnowledgeLayout />
    );
  }

  return (
    <ResourceAnnotationsProvider>
      <GlobalEventsConnector />
      <div className="h-screen semiont-knowledge-layout flex flex-col overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          <KnowledgeSidebarWrapper />
          <main className="flex-1 w-full px-2 pb-6 flex flex-col overflow-hidden">
            <div className="w-full mx-auto flex-1 flex flex-col h-full overflow-hidden">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </ResourceAnnotationsProvider>
  );
}

export default function KnowledgeLayout() {
  // AuthShell is mounted by the parent ProtectedLayout in App.tsx so it
  // survives navigation between know/, admin/, and moderate/ sections.
  return <KnowledgeLayoutBody />;
}
