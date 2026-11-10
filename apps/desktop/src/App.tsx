import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ClickAction, SelectionMotivation } from '@semiont/react-ui';
import type { OpenedSession, SessionEndReason } from '@semiont/sdk';
import { appTitle, appVersion, appCommit, appBuildDate } from 'virtual:app-config';
import { connect, signOut, type ChatSession, type KbConnection } from './lib/session';
import { loadUserConfig, saveUserConfig } from './lib/config-store';
import { kbTargetFor, type KbEntry, type UserConfig } from './lib/user-config';
import { applyTheme, loadTheme, saveTheme, type Theme } from './lib/theme';
import {
  loadSessions,
  saveSessions,
  newSession,
  sessionsForKb,
  type AppChatSession,
} from './lib/chat-sessions';
import { getPref, setPref } from './lib/prefs';
import { CHAT_MIN, DOC_DEFAULT, clampDocWidth, mainLayout, type ResourcePresentation } from './lib/split-layout';
import { KbNav } from './components/KbNav';
import { WorkspaceTabs, localRootPathFromTabId, localRootTabId } from './components/WorkspaceTabs';
import { AppearancePanel } from './components/AppearancePanel';
import { LanguagePanel } from './components/LanguagePanel';
import { AboutModal } from './components/AboutModal';
import { InferenceModal } from './components/InferenceModal';
import { RemoteServiceModal, type RemoteService } from './components/RemoteServiceModal';
import { ServiceGroupModal, type DesktopServiceGroup } from './components/ServiceGroupModal';
import { KnowledgeBaseModal, KnowledgeBasesModal, type KnowledgeBaseRow, type KnowledgeBasesState, type NewKnowledgeBaseOptions } from './components/KnowledgeBasesModal';
import { KnowledgeBaseUsersModal } from './components/KnowledgeBaseUsersModal';
import { KnowledgeBaseLogsModal } from './components/KnowledgeBaseLogsModal';
import { TelemetryModal } from './components/TelemetryModal';
import { RuntimeModal } from './components/RuntimeModal';
import type { GitCheck } from './components/GitStatusSection';
import { SecretsModal, type SecretsCheck } from './components/SecretsModal';
import { McpModal } from './components/McpModal';
import { AppFooter } from './components/AppFooter';
import { ChatPane, type LogEntry } from './components/ChatPane';
import { ResourceComposeModal } from './components/ResourceComposeModal';
import { ResourceView } from './components/ResourceView';
import type { ViewerPrefs } from './components/ViewerPrefControls';
import {
  controlFailureText,
  type ControlAnswerState,
  type ControlNotice,
  type ControlOutcome,
  type ControlRequestParams,
  type LauncherBridge,
  type McpProcessStatus,
} from './lib/launcher-bridge';
import type { OllamaInfo } from './lib/ollama-info';
import type { ControlMethod, ControlProgress, ControlServiceStatus } from '../electron/control-types.gen';

// In Electron the preload exposes window.configBridge; the web build has no such bridge.
const isElectron = typeof window !== 'undefined' && window.configBridge !== undefined;

// Resizable sidebar: width in px, clamped and persisted via prefs (XDG file in
// Electron, localStorage on the web).
const SIDEBAR_KEY = 'sidebar-width';
const DOC_WIDTH_KEY = 'doc-pane-width';
const ACTIVE_SESSION_KEY = 'active-session-id';
const ACTIVE_SESSIONS_KEY = 'active-session-ids-by-kb';
const OPEN_KB_TABS_KEY = 'open-kb-tabs';
const ACTIVE_KB_TAB_KEY = 'active-kb-tab-uri';
const KB_ROOT_ALIASES_KEY = 'kb-display-names-by-root';
const CLICK_ACTION_KEY = 'viewer-click-action';
const MOTIVATION_KEY = 'viewer-motivation';
const CONNECTED_KBS_KEY = 'connected-kb-uris';
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 272; // 17rem
const clampWidth = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));

/** Send the launcher one control request; resolves with its answer and optionally forwards progress notices. */
function askLauncher<M extends ControlMethod>(
  bridge: LauncherBridge,
  method: M,
  params: ControlRequestParams<M>,
  onNotice?: (notice: ControlNotice) => void,
): Promise<ControlOutcome<M>> {
  return new Promise((resolve, reject) => {
    bridge.startControl(method, params, (event) => {
      if (event.kind === 'answer') resolve(event.outcome);
      else onNotice?.(event.notice);
    }).catch(reject);
  });
}

/** The answer to the latest `method` request a view sent the launcher, and how to send one.
 *  An answer to an earlier request is dropped: the latest one's is what the view shows. */
function useLauncherAnswer<M extends ControlMethod>(
  method: M,
): [ControlAnswerState<M>, (params: ControlRequestParams<M>) => void] {
  const [state, setState] = useState<ControlAnswerState<M>>({ status: 'loading' });
  const latest = useRef(0);
  const ask = useCallback((params: ControlRequestParams<M>) => {
    const bridge = window.launcherBridge;
    if (bridge === undefined) {
      setState({ status: 'unavailable' });
      return;
    }
    const asked = ++latest.current;
    setState({ status: 'loading' });
    void askLauncher(bridge, method, params).then((outcome) => {
      if (latest.current === asked) setState({ status: 'answered', outcome });
    });
  }, [method]);
  return [state, ask];
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/** What a person reads when a session ends by itself, by why it ended. */
const SESSION_ENDED: Record<SessionEndReason, string> = {
  expired: 'The session expired. Connect to sign in again.',
  refused: 'The knowledge base refused the session. Connect to sign in again.',
};

function withoutKb(connections: Record<string, KbConnection>, kbUri: string): Record<string, KbConnection> {
  const next = { ...connections };
  delete next[kbUri];
  return next;
}

/** Rebuild a KB entry with its alias set (non-empty) or cleared, preserving the rest. */
function withAlias(k: KbEntry, alias: string): KbEntry {
  const next: KbEntry = { uri: k.uri };
  if (alias.trim()) next.alias = alias.trim();
  return next;
}

/** Why a control request has no result, as a person reads it; null when it has one. */
function failureTextOf<M extends ControlMethod>(outcome: ControlOutcome<M>): string | null {
  return outcome.ok ? null : controlFailureText(outcome.error);
}

type KnowledgeBaseStackFacts = Pick<KnowledgeBaseRow, 'status' | 'statusDetail' | 'gatewayUrl' | 'services'>;

/** A row's status, from the launcher's status of the root's stack. */
function stackFacts(outcome: ControlOutcome<'status.snapshot'>): KnowledgeBaseStackFacts {
  if (!outcome.ok) return { status: 'unknown', statusDetail: controlFailureText(outcome.error), services: [] };
  const [stack] = outcome.result.knowledgeBases;
  if (stack === undefined) return { status: 'stopped', services: [] };
  const stackRoles = new Set(stack.services.map((service) => service.role));
  const shared = outcome.result.shared.filter((service) => service.serves?.includes(stack.name) && !stackRoles.has(service.role));
  const services: ControlServiceStatus[] = [...stack.services, ...shared];
  const gateway = stack.gateway === undefined ? {} : { gatewayUrl: stack.gateway };
  if (stack.starting) return { status: 'starting', services, ...gateway };
  const hasRunningServices = stack.services.some((service) => service.state === 'running');
  if (!hasRunningServices) return { status: 'stopped', services, ...gateway };
  if (stack.healthy) return { status: 'running', services, ...gateway };
  const silent = services.filter((service) => service.counted && !service.healthy).map((service) => service.role);
  return {
    status: 'attention',
    services,
    ...(silent.length === 0 ? {} : { statusDetail: `Not answering: ${silent.join(', ')}.` }),
    ...gateway,
  };
}

function normalizeGatewayUri(uri: string): string {
  try {
    const url = new URL(uri);
    url.pathname = url.pathname.replace(/\/+$/u, '');
    return url.origin + url.pathname;
  } catch {
    return uri.replace(/\/+$/u, '');
  }
}

export function App() {
  const [config, setConfig] = useState<UserConfig | null>(null); // null = still loading
  // One live connection per connected KB (its own token-refreshing SemiontSession).
  const [connections, setConnections] = useState<Record<string, KbConnection>>({});
  const [sessions, setSessions] = useState<AppChatSession[]>([]);
  const [openKbTabUris, setOpenKbTabUris] = useState<string[]>([]);
  const [activeKbTabUri, setActiveKbTabUri] = useState<string | null>(null);
  const activeRootPath = activeKbTabUri === null ? null : localRootPathFromTabId(activeKbTabUri);
  const [activeSessionIdsByKb, setActiveSessionIdsByKb] = useState<Record<string, string>>({});
  const [activeResourcesByKb, setActiveResourcesByKb] = useState<Record<string, { id: string; kbUri: string; name: string; presentation: ResourcePresentation }>>({});
  const [composeTarget, setComposeTarget] = useState<{ kbUri: string; session: ChatSession } | null>(null);
  const [kbAliasesByRoot, setKbAliasesByRoot] = useState<Record<string, string>>({});
  const kbAliasesLoaded = useRef(false);
  const activeSessionId = activeKbTabUri === null ? null : activeSessionIdsByKb[activeKbTabUri] ?? null;
  const activeSession = activeSessionId === null ? null : sessions.find((s) => s.id === activeSessionId) ?? null;
  // The document shown in the main pane. It coexists with the active chat: when both are
  // set and the pane is wide enough, the main pane splits (chat left, document right).
  const activeResource = activeKbTabUri === null ? null : activeResourcesByKb[activeKbTabUri] ?? null;
  const [showAppearance, setShowAppearance] = useState(false);
  const [showLanguage, setShowLanguage] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showInference, setShowInference] = useState(false);
  const [remoteService, setRemoteService] = useState<RemoteService | null>(null);
  const [inferenceInfo, setInferenceInfo] = useState<OllamaInfo | null>(null);
  const [inferenceUnavailable, setInferenceUnavailable] = useState(false);
  const [serviceGroup, setServiceGroup] = useState<DesktopServiceGroup | null>(null);
  const [showKnowledgeBasePicker, setShowKnowledgeBasePicker] = useState(false);
  const [showKnowledgeBaseDetails, setShowKnowledgeBaseDetails] = useState(false);
  const [showKnowledgeBaseUsers, setShowKnowledgeBaseUsers] = useState(false);
  const [focusKnowledgeBaseSearch, setFocusKnowledgeBaseSearch] = useState(false);
  const [knowledgeBaseSelectedPath, setKnowledgeBaseSelectedPath] = useState<string | null>(null);
  const [logsRoot, setLogsRoot] = useState<KnowledgeBaseRow | null>(null);
  const [knowledgeBasesState, setKnowledgeBasesState] = useState<KnowledgeBasesState>({ status: 'loading' });
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [showRuntime, setShowRuntime] = useState(false);
  // One snapshot for the status, telemetry and runtime views: opening any of them asks again.
  const [snapshot, askSnapshot] = useLauncherAnswer('status.snapshot');
  const [launcherAbout, askLauncherAbout] = useLauncherAnswer('launcher.about');
  const [gitCheck, setGitCheck] = useState<GitCheck>({ status: 'checking' });
  const [showSecrets, setShowSecrets] = useState(false);
  const [secretsCheck, setSecretsCheck] = useState<SecretsCheck>({ status: 'checking' });
  const [showMcp, setShowMcp] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpProcessStatus>({
    state: 'stopped',
    pid: null,
    startedAt: null,
    memoryBytes: null,
    cpuPercent: null,
    error: null,
  });
  const [theme, setTheme] = useState<Theme>('system');

  const openServiceGroup = useCallback((group: DesktopServiceGroup) => {
    setServiceGroup(group);
    askSnapshot(group === 'record' && activeRootPath !== null
      ? { target: { kind: 'local', root: activeRootPath } }
      : {});
    if (group === 'record') {
      setGitCheck({ status: 'checking' });
      const bridge = window.launcherBridge;
      if (bridge === undefined) {
        setGitCheck({ status: 'unavailable' });
      } else {
        void bridge.gitPath().then(
          (path) => setGitCheck(path === null ? { status: 'missing' } : { status: 'found', path }),
          () => setGitCheck({ status: 'unavailable' }),
        );
      }
    }
  }, [activeRootPath, askSnapshot]);
  const refreshServiceStatus = useCallback(() => {
    askSnapshot(serviceGroup === 'record' && activeRootPath !== null
      ? { target: { kind: 'local', root: activeRootPath } }
      : {});
  }, [activeRootPath, askSnapshot, serviceGroup]);

  const updateKnowledgeBase = useCallback((path: string, update: (row: KnowledgeBaseRow) => KnowledgeBaseRow) => {
    setKnowledgeBasesState((current) => current.status === 'result'
      ? { ...current, result: { ...current.result, roots: current.result.roots.map((row) => (row.path === path ? update(row) : row)) } }
      : current);
  }, []);

  const refreshKnowledgeBases = useCallback(() => {
    setKnowledgeBasesState((current) => current.status === 'result' ? current : { status: 'loading' });
    const bridge = window.launcherBridge;
    if (bridge === undefined) {
      setKnowledgeBasesState({ status: 'failed', message: 'The launcher bridge is available in the desktop app only.' });
      return;
    }
    void askLauncher(bridge, 'roots.list', {}).then((outcome) => {
      if (!outcome.ok) {
        setKnowledgeBasesState({ status: 'failed', message: controlFailureText(outcome.error) });
        return;
      }
      const rows: KnowledgeBaseRow[] = outcome.result.roots
        .flatMap((root) => (root.placement === 'local' && root.path !== undefined
          ? [{ ...root, path: root.path, status: 'checking' as const }]
          : []))
        .sort((left, right) => (right.lastUsed ?? '').localeCompare(left.lastUsed ?? ''));
      const { warnings } = outcome.result;
      setKnowledgeBasesState({ status: 'result', result: { roots: rows, ...(warnings === undefined ? {} : { warnings }) } });
      for (const row of rows) {
        void askLauncher(bridge, 'status.snapshot', { target: { kind: 'local', root: row.path } }).then((answer) => {
          updateKnowledgeBase(row.path, (current) => ({ ...current, ...stackFacts(answer) }));
        });
      }
    });
  }, [updateKnowledgeBase]);

  const openKnowledgeBases = useCallback((focusSearch = false, selectedPath: string | null = null) => {
    setShowKnowledgeBasePicker(true);
    setFocusKnowledgeBaseSearch(focusSearch);
    setKnowledgeBaseSelectedPath(selectedPath);
    refreshKnowledgeBases();
  }, [refreshKnowledgeBases]);

  const createKnowledgeBase = useCallback(async (
    options: NewKnowledgeBaseOptions,
    onProgress: (progress: ControlProgress) => void,
  ) => {
    const bridge = window.launcherBridge;
    if (bridge === undefined) throw new Error('The launcher bridge is available in the desktop app only.');
    const outcome = await askLauncher(bridge, 'roots.init', options, (notice) => {
      if (notice.method === 'notifications/progress') onProgress(notice.params);
    });
    if (!outcome.ok) throw new Error(controlFailureText(outcome.error));
    return outcome.result.path;
  }, []);

  const openAbout = useCallback(() => setShowAbout(true), []);

  const openInference = useCallback(() => {
    setShowInference(true);
    setInferenceInfo(null);
    setInferenceUnavailable(false);
    const bridge = window.launcherBridge;
    if (bridge === undefined) {
      setInferenceUnavailable(true);
      return;
    }
    void bridge.ollamaInfo().then(
      setInferenceInfo,
      () => setInferenceUnavailable(true),
    );
  }, []);

  const openTelemetry = useCallback(() => {
    setShowTelemetry(true);
    askSnapshot({});
  }, [askSnapshot]);

  const openRuntime = useCallback(() => {
    setShowRuntime(true);
    askSnapshot({});
    askLauncherAbout({});
  }, [askSnapshot, askLauncherAbout]);

  const openSecrets = useCallback(() => {
    setShowSecrets(true);
    setSecretsCheck({ status: 'checking' });
    const bridge = window.launcherBridge;
    if (bridge === undefined) {
      setSecretsCheck({ status: 'unavailable' });
      return;
    }
    void bridge.opPath().then(
      (path) => setSecretsCheck(path === null ? { status: 'missing' } : { status: 'found', path }),
      () => setSecretsCheck({ status: 'unavailable' }),
    );
  }, []);

  const openMcp = useCallback(() => {
    setShowMcp(true);
    const bridge = window.launcherBridge;
    if (bridge === undefined) {
      setMcpStatus({ state: 'failed', pid: null, startedAt: null, memoryBytes: null, cpuPercent: null, error: 'MCP process control is available in the Desktop app only.' });
      return;
    }
    void bridge.mcpStatus().then(setMcpStatus, (error: unknown) => {
      setMcpStatus({ state: 'failed', pid: null, startedAt: null, memoryBytes: null, cpuPercent: null, error: error instanceof Error ? error.message : String(error) });
    });
  }, []);

  const startMcp = useCallback(() => {
    const bridge = window.launcherBridge;
    if (bridge === undefined) return;
    setMcpStatus({ state: 'starting', pid: null, startedAt: null, memoryBytes: null, cpuPercent: null, error: null });
    void bridge.startMcp().then(setMcpStatus, (error: unknown) => {
      setMcpStatus({ state: 'failed', pid: null, startedAt: null, memoryBytes: null, cpuPercent: null, error: error instanceof Error ? error.message : String(error) });
    });
  }, []);

  const stopMcp = useCallback(() => {
    const bridge = window.launcherBridge;
    if (bridge === undefined) return;
    setMcpStatus((current) => ({ ...current, state: 'stopping' }));
    void bridge.stopMcp().then(setMcpStatus, (error: unknown) => {
      setMcpStatus({ state: 'failed', pid: null, startedAt: null, memoryBytes: null, cpuPercent: null, error: error instanceof Error ? error.message : String(error) });
    });
  }, []);

  useEffect(() => {
    const bridge = window.launcherBridge;
    if (bridge === undefined) return;
    void bridge.mcpStatus().then(setMcpStatus, () => undefined);
  }, []);

  useEffect(() => {
    const bridge = window.launcherBridge;
    if (bridge === undefined || mcpStatus.state !== 'running') return undefined;
    const timer = window.setInterval(() => {
      void bridge.mcpStatus().then(setMcpStatus, () => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [mcpStatus.state]);

  // App-global viewer prefs (TOOLBAR-PREFS-AS-PROPS): click action + selection motivation are
  // app settings (footer controls by the gear), passed as controlled props to every mounted
  // viewer. Mode is per-message (each MessageView's pencil); shape stays per-instance.
  const [clickAction, setClickAction] = useState<ClickAction>('follow');
  const [motivation, setMotivation] = useState<SelectionMotivation | null>('linking');
  useEffect(() => {
    void getPref<ClickAction>(CLICK_ACTION_KEY, 'follow').then(setClickAction);
    void getPref<SelectionMotivation>(MOTIVATION_KEY, 'linking').then(setMotivation);
  }, []);
  useEffect(() => {
    void getPref<Record<string, string>>(KB_ROOT_ALIASES_KEY, {}).then((aliases) => {
      setKbAliasesByRoot(aliases);
      kbAliasesLoaded.current = true;
    });
  }, []);
  useEffect(() => {
    if (kbAliasesLoaded.current) void setPref(KB_ROOT_ALIASES_KEY, kbAliasesByRoot);
  }, [kbAliasesByRoot]);
  const viewerPrefs: ViewerPrefs = useMemo(
    () => ({
      clickAction,
      onClickActionChange: (a) => {
        setClickAction(a);
        void setPref(CLICK_ACTION_KEY, a);
      },
      motivation,
      onMotivationChange: (m) => {
        setMotivation(m);
        if (m !== null) void setPref(MOTIVATION_KEY, m);
      },
    }),
    [clickAction, motivation],
  );
  // Bumped after resource creation or View > Reload to refresh open document lists.
  const [docsRefresh, setDocsRefresh] = useState(0);
  useEffect(() => window.appMenuBridge?.onAboutRequested(openAbout), [openAbout]);
  useEffect(() => window.appMenuBridge?.onDocumentsReloadRequested(() => {
    setDocsRefresh((value) => value + 1);
  }), []);
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR_DEFAULT);
  // Split-view document-pane width (px), persisted like the sidebar; clamped at render
  // against the measured pane so a stale saved value can't starve the chat column.
  const [docWidth, setDocWidth] = useState<number>(DOC_DEFAULT);
  const sidebarLoaded = useRef(false);
  const docWidthLoaded = useRef(false);
  const sessionsLoaded = useRef(false);
  const workspaceLoaded = useRef(false);
  const themeLoaded = useRef(false);
  const bootstrapped = useRef(false);

  useEffect(() => {
    document.title = appTitle;
  }, []);

  // Colour theme: load the saved choice and apply it (sets data-theme on <html>, which both
  // our CSS and the @semiont/react-ui viewer respond to). Persist on change; while following
  // the system, re-apply when the OS preference flips.
  useEffect(() => {
    void loadTheme().then((t) => {
      setTheme(t);
      applyTheme(t);
      themeLoaded.current = true;
    });
  }, []);
  useEffect(() => {
    if (!themeLoaded.current) return;
    applyTheme(theme);
    void saveTheme(theme);
  }, [theme]);
  useEffect(() => {
    if (theme !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  // Load the saved sidebar width (async — Electron persists via the main process).
  useEffect(() => {
    void getPref(SIDEBAR_KEY, SIDEBAR_DEFAULT).then((w) => {
      setSidebarWidth(clampWidth(Number(w) || SIDEBAR_DEFAULT));
      sidebarLoaded.current = true;
    });
  }, []);

  // Persist on change — only after the load, so the default never clobbers the saved value.
  useEffect(() => {
    if (sidebarLoaded.current) void setPref(SIDEBAR_KEY, sidebarWidth);
  }, [sidebarWidth]);

  useEffect(() => {
    void getPref(DOC_WIDTH_KEY, DOC_DEFAULT).then((w) => {
      setDocWidth(Number(w) || DOC_DEFAULT);
      docWidthLoaded.current = true;
    });
  }, []);
  useEffect(() => {
    if (docWidthLoaded.current) void setPref(DOC_WIDTH_KEY, docWidth);
  }, [docWidth]);

  // Electron nicety: when a doc opens beside an active chat, ask the main process to grow
  // the window enough for both panes (it clamps to the display and skips maximized);
  // restore on close if the user hasn't resized meanwhile. No-op on the web.
  const docWasOpen = useRef(false);
  useEffect(() => {
    const open = activeResource !== null && activeSessionId !== null;
    if (open === docWasOpen.current) return;
    docWasOpen.current = open;
    const bridge = window.windowBridge;
    if (bridge === undefined) return;
    if (open) void bridge.ensureWidth(sidebarWidth + 1 + CHAT_MIN + 1 + docWidth + 8);
    else void bridge.restoreWidth();
    // width deps deliberately included: the open/close guard above makes them inert
  }, [activeResource, activeSessionId, sidebarWidth, docWidth]);

  // Drag the divider to resize the sidebar; window-level listeners keep tracking even if
  // the pointer outruns the 1px handle. `body.resizing` sets the cursor and blocks
  // text-selection for the duration.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: PointerEvent) => setSidebarWidth(clampWidth(startW + ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add('resizing');
  };

  const nudgeResize = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setSidebarWidth((w) => clampWidth(w + (e.key === 'ArrowLeft' ? -16 : 16)));
  };

  // Load the per-user config once (XDG file in Electron, localStorage on the web).
  useEffect(() => {
    void loadUserConfig().then(setConfig);
  }, []);

  const saveConfig = async (next: UserConfig) => {
    setConfig(next);
    await saveUserConfig(next);
  };

  // Connect to one KB and hold its live session. Multiple KBs can be connected at once,
  // each with its own token-renewal lifecycle. Reconnecting replaces any stale state.
  // `interactive` is whether the person may be sent to the issuer to sign in: the Connect
  // button's yes, a launch's no (a launch resumes stored sessions and opens nothing).
  const connectKb = async (kbUri: string, interactive: boolean, override?: KbEntry) => {
    const kb = override ?? config?.kbs.find((k) => k.uri === kbUri);
    if (!kb) return;
    const target = kbTargetFor(kb);
    if (target === null) {
      setConnections((c) => ({ ...c, [kbUri]: { connecting: false, error: 'Invalid KB URL' } }));
      return;
    }
    setConnections((c) => ({ ...c, [kbUri]: { connecting: true } }));
    try {
      let live: OpenedSession | undefined;
      const connected = await connect(target, {
        interactive,
        onEnded: (reason) => {
          if (live !== undefined) pendingDispose.current.push(live);
          setConnections((c) => ({ ...c, [kbUri]: { connecting: false, error: SESSION_ENDED[reason] } }));
        },
      });
      if (connected === null) {
        setConnections((c) => withoutKb(c, kbUri));
        return;
      }
      live = connected.opened;
      setConnections((c) => ({ ...c, [kbUri]: { ...connected, connecting: false } }));
    } catch (e) {
      setConnections((c) => ({ ...c, [kbUri]: { connecting: false, error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  // Sessions removed from `connections` but not yet ended. Drained by the effect
  // below, which runs after the removal commits — so viewers of that KB have already
  // unmounted and run their unsubscribe cleanups against a live transport. (Ending
  // inside the setConnections updater tears the transport down mid-render, under
  // subscribers that are still mounted.)
  const pendingDispose = useRef<OpenedSession[]>([]);
  useEffect(() => {
    const doomed = pendingDispose.current;
    if (doomed.length === 0) return;
    pendingDispose.current = [];
    for (const opened of doomed) opened.dispose(); // token renewal, bus subscriptions, and the client's stream
  }, [connections]);

  // Disconnecting signs out: the stored session is revoked at the issuer and forgotten, so
  // connected and signed in are one state.
  const disconnectKb = (kbUri: string) => {
    const opened = connections[kbUri]?.opened;
    if (opened) pendingDispose.current.push(opened);
    setConnections((c) => withoutKb(c, kbUri));
    const kb = config?.kbs.find((k) => k.uri === kbUri);
    const target = kb ? kbTargetFor(kb) : null;
    if (target !== null) void signOut(target);
  };

  const operateKnowledgeBase = (root: KnowledgeBaseRow, operation: 'starting' | 'stopping') => {
    const bridge = window.launcherBridge;
    if (bridge === undefined) return;
    updateKnowledgeBase(root.path, (row) => {
      const next = { ...row, operation, operationStartedAt: Date.now() };
      delete next.operationError;
      delete next.operationErrorAction;
      next.operationProgress = [];
      return next;
    });
    const target = { kind: 'local' as const, root: root.path };
    let progressForOperation: ControlProgress[] = [];
    const onProgress = (notice: ControlNotice) => {
      if (notice.method !== 'notifications/progress') return;
      progressForOperation = [...progressForOperation, notice.params].slice(-200);
      updateKnowledgeBase(root.path, (row) => ({
        ...row,
        operationProgress: progressForOperation,
      }));
    };
    let statusRefreshInFlight = false;
    const refreshOperationStatus = () => {
      if (statusRefreshInFlight) return;
      statusRefreshInFlight = true;
      void askLauncher(bridge, 'status.snapshot', { target }).then((answer) => {
        updateKnowledgeBase(root.path, (row) => {
          const facts = stackFacts(answer);
          const next = { ...row, ...facts };
          if (facts.statusDetail === undefined) delete next.statusDetail;
          if (facts.gatewayUrl === undefined) delete next.gatewayUrl;
          return next;
        });
      }).catch(() => undefined).finally(() => {
        statusRefreshInFlight = false;
      });
    };
    refreshOperationStatus();
    const statusTimer = window.setInterval(refreshOperationStatus, 3000);
    const request = operation === 'starting'
      ? askLauncher(bridge, 'stack.start', { target }, onProgress)
      : askLauncher(bridge, 'stack.stop', { target }, onProgress);
    void request.then(async (outcome) => {
      window.clearInterval(statusTimer);
      const failureMessage = failureTextOf(outcome);
      if (failureMessage === null) {
        refreshKnowledgeBases();
        return;
      }
      const lastFailure = [...progressForOperation].reverse().find((progress) => progress.kind === 'fail');
      const message = failureMessage.includes('progress is everything it printed') && lastFailure !== undefined
        ? `${lastFailure.text} (control.failed)`
        : failureMessage;
      const status = await askLauncher(bridge, 'status.snapshot', { target });
      updateKnowledgeBase(root.path, (row) => {
        const facts = stackFacts(status);
        const next = { ...row, ...facts, operationError: message, operationErrorAction: 'launcher' as const };
        delete next.operation;
        delete next.operationStartedAt;
        if (facts.statusDetail === undefined) delete next.statusDetail;
        if (facts.gatewayUrl === undefined) delete next.gatewayUrl;
        return next;
      });
    }).catch((error: unknown) => {
      window.clearInterval(statusTimer);
      const message = error instanceof Error ? error.message : String(error);
      updateKnowledgeBase(root.path, (row) => {
        const next = { ...row, operationError: message, operationErrorAction: 'launcher' as const };
        delete next.operation;
        delete next.operationStartedAt;
        return next;
      });
    });
  };

  const forgetKnowledgeBase = (root: KnowledgeBaseRow) => {
    const bridge = window.launcherBridge;
    if (bridge === undefined) return;
    updateKnowledgeBase(root.path, (row) => {
      const next = { ...row, operation: 'forgetting' as const, operationStartedAt: Date.now() };
      delete next.operationError;
      delete next.operationErrorAction;
      return next;
    });
    void askLauncher(bridge, 'roots.forget', { root: root.path }).then((outcome) => {
      if (outcome.ok) {
        refreshKnowledgeBases();
        return;
      }
      updateKnowledgeBase(root.path, (row) => {
        const next = { ...row, operationError: controlFailureText(outcome.error), operationErrorAction: 'forget' as const };
        delete next.operation;
        delete next.operationStartedAt;
        return next;
      });
    }, (error: unknown) => {
      const nextMessage = error instanceof Error ? error.message : String(error);
      updateKnowledgeBase(root.path, (row) => {
        const next = { ...row, operationError: nextMessage, operationErrorAction: 'forget' as const };
        delete next.operation;
        delete next.operationStartedAt;
        return next;
      });
    });
  };

  const loginKnowledgeBase = async (root: KnowledgeBaseRow) => {
    if (config === null || root.gatewayUrl === undefined) return;
    let kb = config.kbs.find((entry) => normalizeGatewayUri(entry.uri) === normalizeGatewayUri(root.gatewayUrl!));
    if (kb === undefined) {
      kb = { uri: root.gatewayUrl, ...(root.siteName ? { alias: root.siteName } : {}) };
      await saveConfig({ ...config, kbs: [...config.kbs, kb] });
    }
    void connectKb(kb.uri, true, kb);
  };

  const logoutKnowledgeBase = (root: KnowledgeBaseRow) => {
    if (root.activeSessionUri !== undefined) disconnectKb(root.activeSessionUri);
  };

  const openKnowledgeBaseTab = (root: KnowledgeBaseRow) => {
    if (config === null) return;
    const uri = root.configuredUri ?? root.gatewayUrl;
    if (uri === undefined) {
      openRootTab(root.path);
      setShowKnowledgeBasePicker(false);
      return;
    }
    let kb = config.kbs.find((entry) => normalizeGatewayUri(entry.uri) === normalizeGatewayUri(uri));
    const rootAlias = kbAliasesByRoot[root.path];
    if (kb === undefined) {
      const alias = rootAlias ?? root.siteName;
      kb = { uri, ...(alias === undefined ? {} : { alias }) };
      saveConfig({ ...config, kbs: [...config.kbs, kb] });
    } else if (rootAlias !== undefined && kb.alias !== rootAlias) {
      const configuredUri = kb.uri;
      const renamed = withAlias(kb, rootAlias);
      kb = renamed;
      saveConfig({ ...config, kbs: config.kbs.map((entry) => entry.uri === configuredUri ? renamed : entry) });
    }
    const rootTabId = localRootTabId(root.path);
    setOpenKbTabUris((current) => current.filter((id) => id !== rootTabId));
    openKbTab(kb.uri);
    setShowKnowledgeBasePicker(false);
  };

  const renameKnowledgeBase = (root: KnowledgeBaseRow, alias: string) => {
    setKbAliasesByRoot((current) => {
      const next = { ...current };
      if (alias === '') delete next[root.path];
      else next[root.path] = alias;
      return next;
    });
    if (config === null) return;
    const uri = root.configuredUri ?? root.gatewayUrl;
    if (uri === undefined) return;
    const configured = config.kbs.find((entry) => normalizeGatewayUri(entry.uri) === normalizeGatewayUri(uri));
    if (configured !== undefined) {
      saveConfig({ ...config, kbs: config.kbs.map((entry) => entry.uri === configured.uri ? withAlias(entry, alias) : entry) });
    }
  };

  // On launch, once the config is in: load sessions + the last active session, and
  // auto-reconnect the KBs that were connected last run (those still in the config).
  useEffect(() => {
    if (config === null || bootstrapped.current) return;
    bootstrapped.current = true;
    void (async () => {
      const [loaded, savedActive, savedActiveByKb, savedTabs, savedTab, connectedUris] = await Promise.all([
        loadSessions(),
        getPref<string | null>(ACTIVE_SESSION_KEY, null),
        getPref<Record<string, string>>(ACTIVE_SESSIONS_KEY, {}),
        getPref<string[] | null>(OPEN_KB_TABS_KEY, null),
        getPref<string | null>(ACTIVE_KB_TAB_KEY, null),
        getPref<string[]>(CONNECTED_KBS_KEY, []),
      ]);
      setSessions(loaded);
      const configuredUris = new Set(config.kbs.map((kb) => kb.uri));
      const tabs = [...new Set(savedTabs ?? config.kbs.map((kb) => kb.uri))].filter((id) => configuredUris.has(id) || localRootPathFromTabId(id) !== null);
      const sessionsById = new Map(loaded.map((session) => [session.id, session]));
      const activeByKb = Object.fromEntries(Object.entries(savedActiveByKb).filter(([uri, id]) => configuredUris.has(uri) && sessionsById.get(id)?.kbUri === uri));
      if (savedActive !== null) {
        const legacyActive = sessionsById.get(savedActive);
        if (legacyActive !== undefined && configuredUris.has(legacyActive.kbUri)) activeByKb[legacyActive.kbUri] = legacyActive.id;
      }
      for (const uri of tabs) {
        if (activeByKb[uri] === undefined) {
          const recent = sessionsForKb(loaded, uri)[0];
          if (recent !== undefined) activeByKb[uri] = recent.id;
        }
      }
      const activeTab = savedTab !== null && tabs.includes(savedTab)
        ? savedTab
        : savedActive !== null && sessionsById.get(savedActive) !== undefined && tabs.includes(sessionsById.get(savedActive)!.kbUri)
          ? sessionsById.get(savedActive)!.kbUri
          : tabs[0] ?? null;
      setOpenKbTabUris(tabs);
      setActiveKbTabUri(activeTab);
      setActiveSessionIdsByKb(activeByKb);
      sessionsLoaded.current = true;
      workspaceLoaded.current = true;
      for (const uri of connectedUris) {
        if (config.kbs.some((k) => k.uri === uri)) void connectKb(uri, false);
      }
    })();
  }, [config]);

  // Persist sessions + the active selection (only after the initial load).
  useEffect(() => {
    if (sessionsLoaded.current) void saveSessions(sessions);
  }, [sessions]);
  useEffect(() => {
    if (sessionsLoaded.current) void setPref(ACTIVE_SESSION_KEY, activeSessionId);
  }, [activeSessionId]);
  useEffect(() => {
    if (!workspaceLoaded.current) return;
    void setPref(OPEN_KB_TABS_KEY, openKbTabUris);
    void setPref(ACTIVE_KB_TAB_KEY, activeKbTabUri);
    void setPref(ACTIVE_SESSIONS_KEY, activeSessionIdsByKb);
  }, [openKbTabUris, activeKbTabUri, activeSessionIdsByKb]);

  // Remember which KBs are connected, to auto-reconnect them next launch.
  useEffect(() => {
    if (!bootstrapped.current) return;
    const connected = Object.entries(connections)
      .filter(([, c]) => c.opened !== undefined)
      .map(([uri]) => uri);
    void setPref(CONNECTED_KBS_KEY, connected);
  }, [connections]);

  const selectWorkspaceTab = (tabId: string) => {
    setActiveKbTabUri(tabId);
    if (config === null) return;
    const uri = config.kbs.find((kb) => kb.uri === tabId)?.uri;
    if (uri === undefined) return;
    if (activeSessionIdsByKb[uri] === undefined) {
      const recent = sessionsForKb(sessions, uri)[0];
      if (recent !== undefined) setActiveSessionIdsByKb((current) => ({ ...current, [uri]: recent.id }));
    }
  };

  const openKbTab = (uri: string) => {
    setOpenKbTabUris((current) => current.includes(uri) ? current : [...current, uri]);
    selectWorkspaceTab(uri);
  };

  const openRootTab = (path: string) => {
    const id = localRootTabId(path);
    setOpenKbTabUris((current) => current.includes(id) ? current : [...current, id]);
    setActiveKbTabUri(id);
  };

  const closeKbTab = (tabId: string) => {
    const index = openKbTabUris.indexOf(tabId);
    if (index < 0) return;
    const remaining = openKbTabUris.filter((openUri) => openUri !== tabId);
    setOpenKbTabUris(remaining);
    if (activeKbTabUri === tabId) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next === undefined) setActiveKbTabUri(null);
      else selectWorkspaceTab(next);
    }
  };

  // --- Session CRUD ---
  const handleNewChat = (kbUri: string) => {
    const s = newSession(kbUri);
    setSessions((prev) => [...prev, s]);
    setActiveSessionIdsByKb((current) => ({ ...current, [kbUri]: s.id })); // any open document for this KB stays put
  };
  // Mutate the active session's entries (App owns the sessions store; ChatPane drives it).
  const setActiveEntries = (updater: (prev: LogEntry[]) => LogEntry[]) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, entries: updater(s.entries), updatedAt: Date.now() } : s)),
    );
  };

  // --- Open a document in the main pane (beside the chat when there's room) ---
  // Rendered natively via @semiont/react-ui's bring-your-own-session ResourceViewer, so this
  // works in both the web and Electron builds. `name` is what the nav row shows; a reference
  // followed from inside the viewer arrives with the id as its name.
  const openResource = (kbUri: string, id: string, name: string, presentation: ResourcePresentation) => setActiveResourcesByKb((current) => ({ ...current, [kbUri]: { kbUri, id, name, presentation } }));
  const openNewDocument = (kbUri: string) => {
    const session = connections[kbUri]?.opened?.session;
    if (session === undefined) return;
    setComposeTarget({ kbUri, session });
  };
  const closeActiveResource = () => {
    if (activeKbTabUri === null) return;
    setActiveResourcesByKb((current) => {
      const next = { ...current };
      delete next[activeKbTabUri];
      return next;
    });
  };
  // Selecting a chat session leaves any open document in place (split view).
  const selectSession = (id: string) => {
    const selected = sessions.find((session) => session.id === id);
    if (selected === undefined) return;
    setActiveSessionIdsByKb((current) => ({ ...current, [selected.kbUri]: id }));
    setActiveResourcesByKb((current) => {
      const resource = current[selected.kbUri];
      return resource === undefined ? current : { ...current, [selected.kbUri]: { ...resource, presentation: 'chat-and-document' } };
    });
  };

  if (config === null) return <p className="app__connecting">Loading…</p>;

  const knowledgeBaseRows = knowledgeBasesState.status === 'result'
    ? knowledgeBasesState.result.roots.map((root) => {
        const active = Object.entries(connections).find(([uri, connection]) => connection.opened !== undefined && (
          (root.did !== undefined && connection.description?.domain !== undefined && `did:web:${connection.description.domain}` === root.did)
          || (root.gatewayUrl !== undefined && normalizeGatewayUri(uri) === normalizeGatewayUri(root.gatewayUrl))
        ));
        const configured = root.gatewayUrl === undefined
          ? undefined
          : config.kbs.find((kb) => normalizeGatewayUri(kb.uri) === normalizeGatewayUri(root.gatewayUrl!));
        const configuredUri = active?.[0] ?? configured?.uri;
        const desktopAlias = config.kbs.find((kb) => kb.uri === configuredUri)?.alias ?? kbAliasesByRoot[root.path];
        return {
          ...root,
          ...(configuredUri === undefined ? {} : { configuredUri }),
          ...(desktopAlias === undefined ? {} : { desktopAlias }),
          ...(active?.[1].description?.gitBranch === undefined ? {} : { gitBranch: active[1].description.gitBranch }),
          ...(active === undefined ? {} : { activeSessionUri: active[0] }),
        };
      })
    : [];
  const knowledgeBasesModalState: KnowledgeBasesState = knowledgeBasesState.status === 'result'
    ? { ...knowledgeBasesState, result: { ...knowledgeBasesState.result, roots: knowledgeBaseRows } }
    : knowledgeBasesState;

  const activeKbUri = activeKbTabUri === null || activeRootPath !== null ? null : activeKbTabUri;
  const activeKb = activeKbUri === null ? null : config.kbs.find((kb) => kb.uri === activeKbUri) ?? null;
  const activeConn = activeKbUri ? connections[activeKbUri] : undefined;
  const activeKnowledgeBaseRoot = activeRootPath !== null
    ? knowledgeBaseRows.find((root) => root.path === activeRootPath) ?? null
    : activeKbUri === null
      ? null
      : knowledgeBaseRows.find((root) => [root.configuredUri, root.gatewayUrl].some((uri) => uri !== undefined && normalizeGatewayUri(uri) === normalizeGatewayUri(activeKbUri))) ?? null;
  const activeKbConnected = activeRootPath !== null
    ? activeKnowledgeBaseRoot?.activeSessionUri !== undefined
    : activeConn?.opened !== undefined;
  const showWorkspaceNav = activeKbTabUri === null || activeKbConnected;

  return (
    <>
      <div className={isElectron ? 'app app--electron' : 'app'}>
        {isElectron && <div className="app__dragbar" aria-hidden="true" />}
        <WorkspaceTabs
          tabs={openKbTabUris.flatMap((id) => {
            const kb = config.kbs.find((entry) => entry.uri === id);
            if (kb !== undefined) {
              const connection = connections[id];
              return [{ id, uri: id, label: kb.alias ?? connection?.description?.name ?? hostOf(id) }];
            }
            const path = localRootPathFromTabId(id);
            if (path === null) return [];
            const root = knowledgeBasesState.status === 'result' ? knowledgeBasesState.result.roots.find((row) => row.path === path) : undefined;
            return [{ id, label: kbAliasesByRoot[path] ?? root?.desktopAlias ?? root?.siteName ?? path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path }];
          })}
          activeUri={activeKbTabUri}
          connections={connections}
          onSelect={selectWorkspaceTab}
          onClose={closeKbTab}
          onAdd={() => openKnowledgeBases(true)}
        />
        <div className="app__body" style={{ gridTemplateColumns: showWorkspaceNav ? `${sidebarWidth}px 1px 1fr` : '0px 1fr' }}>
          <KbNav
            showWorkspaceContent={showWorkspaceNav}
            kbs={activeKb === null ? [] : [activeKb]}
            hasLocalRootTab={activeRootPath !== null}
            hasActiveKbTab={activeKbTabUri !== null}
            connections={connections}
            sessions={sessions}
            // doc and chat coexist now — both rows light up when both are live
            activeSessionId={activeSessionId}
            activeResourceId={activeResource?.id ?? null}
            docsRefresh={docsRefresh}
            onOpenResource={openResource}
            onNewChat={handleNewChat}
            onNewDocument={openNewDocument}
            onSelectSession={selectSession}
            onOpenInference={openInference}
            onOpenServiceGroup={openServiceGroup}
            onOpenRemoteService={setRemoteService}
            onOpenSecrets={openSecrets}
            onOpenMcp={openMcp}
            mcpStatus={mcpStatus}
            onOpenAppearance={() => setShowAppearance(true)}
            onOpenLanguage={() => setShowLanguage(true)}
            onOpenTelemetry={openTelemetry}
            onOpenRuntime={openRuntime}
            onOpenKnowledgeBase={() => {
              setShowKnowledgeBaseDetails(true);
              refreshKnowledgeBases();
            }}
            onOpenKnowledgeBaseUsers={() => {
              setShowKnowledgeBaseUsers(true);
              refreshKnowledgeBases();
            }}
          />
          {showWorkspaceNav && (
            <div
              className="app__resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={nudgeResize}
            />
          )}
          <MainPane
            viewerPrefs={viewerPrefs}
            hasOpenKb={activeKbTabUri !== null}
            activeRootPath={activeRootPath}
            onOpenKnowledgeBases={() => openKnowledgeBases(activeRootPath === null, activeRootPath)}
            onOpenKnowledgeBaseDetails={() => {
              setShowKnowledgeBaseDetails(true);
              refreshKnowledgeBases();
            }}
            activeSession={activeSession}
            onNewDocument={() => activeSession && openNewDocument(activeSession.kbUri)}
            conn={activeConn}
            activeResource={activeResource}
            resourceSession={activeResource ? connections[activeResource.kbUri]?.opened?.session ?? null : null}
            docWidth={docWidth}
            onDocWidthChange={setDocWidth}
            onCloseResource={closeActiveResource}
            onOpenResource={openResource}
            setActiveEntries={setActiveEntries}
            onResourcesChanged={() => setDocsRefresh((n) => n + 1)}
            onConnect={() => activeKbUri && void connectKb(activeKbUri, true)}
          />
        </div>
      </div>
      {showAppearance && (
        <AppearancePanel theme={theme} onThemeChange={setTheme} onClose={() => setShowAppearance(false)} />
      )}
      {showLanguage && <LanguagePanel onClose={() => setShowLanguage(false)} />}
      {showAbout && (
        <AboutModal
          version={appVersion}
          commit={appCommit}
          buildDate={appBuildDate}
          onClose={() => setShowAbout(false)}
        />
      )}
      {showInference && (
        <InferenceModal
          info={inferenceInfo}
          unavailable={inferenceUnavailable}
          onClose={() => setShowInference(false)}
        />
      )}
      {remoteService !== null && <RemoteServiceModal service={remoteService} onClose={() => setRemoteService(null)} />}
      {serviceGroup !== null && (
        <ServiceGroupModal
          group={serviceGroup}
          state={snapshot}
          selectedRootPath={activeRootPath}
          knowledgeBaseRoot={activeKnowledgeBaseRoot}
          gitCheck={gitCheck}
          onStartKnowledgeBase={(root) => operateKnowledgeBase(root, 'starting')}
          onStopKnowledgeBase={(root) => operateKnowledgeBase(root, 'stopping')}
          onFollowLogs={setLogsRoot}
          onRefresh={refreshServiceStatus}
          onClose={() => setServiceGroup(null)}
        />
      )}
      {showKnowledgeBasePicker && (
        <KnowledgeBasesModal
          state={knowledgeBasesModalState}
          focusSearchOnOpen={focusKnowledgeBaseSearch}
          openTabUris={openKbTabUris}
          activeTabUri={activeKbTabUri}
          initialSelectedPath={knowledgeBaseSelectedPath}
          onRefresh={refreshKnowledgeBases}
          onCreate={createKnowledgeBase}
          onOpenTab={openKnowledgeBaseTab}
          onClose={() => {
            if (logsRoot === null) setShowKnowledgeBasePicker(false);
          }}
        />
      )}
      {showKnowledgeBaseDetails && (
        <KnowledgeBaseModal
          root={activeKnowledgeBaseRoot}
          kb={activeKb}
          connected={activeKnowledgeBaseRoot?.activeSessionUri !== undefined || activeConn?.opened !== undefined}
          onLogin={loginKnowledgeBase}
          onLogout={logoutKnowledgeBase}
          onForget={forgetKnowledgeBase}
          onRenameAlias={renameKnowledgeBase}
          onClose={() => {
            if (logsRoot === null) setShowKnowledgeBaseDetails(false);
          }}
        />
      )}
      {showKnowledgeBaseUsers && (
        <KnowledgeBaseUsersModal
          root={activeKnowledgeBaseRoot}
          kb={activeKb}
          onClose={() => setShowKnowledgeBaseUsers(false)}
        />
      )}
      {logsRoot !== null && <KnowledgeBaseLogsModal root={logsRoot} onClose={() => setLogsRoot(null)} />}
      {showTelemetry && <TelemetryModal state={snapshot} onClose={() => setShowTelemetry(false)} />}
      {showRuntime && (
        <RuntimeModal status={snapshot} about={launcherAbout} onClose={() => setShowRuntime(false)} />
      )}
      {showSecrets && <SecretsModal check={secretsCheck} onClose={() => setShowSecrets(false)} />}
      {showMcp && <McpModal status={mcpStatus} onStart={startMcp} onStop={stopMcp} onClose={() => setShowMcp(false)} />}
      {composeTarget !== null && (
        <ResourceComposeModal
          session={composeTarget.session}
          onClose={() => setComposeTarget(null)}
          onCreated={(id, name) => {
            const target = composeTarget;
            if (target === null) return;
            setComposeTarget(null);
            setDocsRefresh((n) => n + 1);
            selectWorkspaceTab(target.kbUri);
            openResource(target.kbUri, id, name, 'chat-and-document');
          }}
        />
      )}
    </>
  );
}

/** The right pane: the current body (document / chat / split) over the app footer —
 *  the footer (KB status and viewer preference controls) persists across ALL of them. */
function MainPane({
  viewerPrefs,
  hasOpenKb,
  activeRootPath,
  onOpenKnowledgeBases,
  onOpenKnowledgeBaseDetails,
  onNewDocument,
  ...body
}: {
  viewerPrefs: ViewerPrefs;
  hasOpenKb: boolean;
  activeRootPath: string | null;
  onOpenKnowledgeBases: () => void;
  onOpenKnowledgeBaseDetails: () => void;
  onNewDocument: () => void;
  activeSession: AppChatSession | null;
  conn: KbConnection | undefined;
  activeResource: { id: string; kbUri: string; name: string; presentation: ResourcePresentation } | null;
  /** The connected session for the open document's KB (null if that KB isn't connected). */
  resourceSession: ChatSession | null;
  docWidth: number;
  onDocWidthChange: (updater: (prev: number) => number) => void;
  onCloseResource: () => void;
  onOpenResource: (kbUri: string, id: string, name: string, presentation: ResourcePresentation) => void;
  setActiveEntries: (updater: (prev: LogEntry[]) => LogEntry[]) => void;
  onResourcesChanged: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="mainwrap">
      <MainBody viewerPrefs={viewerPrefs} hasOpenKb={hasOpenKb} activeRootPath={activeRootPath} onOpenKnowledgeBases={onOpenKnowledgeBases} onOpenKnowledgeBaseDetails={onOpenKnowledgeBaseDetails} onNewDocument={onNewDocument} {...body} />
      <AppFooter prefs={viewerPrefs} />
    </div>
  );
}

/** The main pane's body. A document selected in navigation takes the full pane; one opened
 *  from chat splits beside it when there's room (`mainLayout`). Chat-side states: empty when
 *  no chat is selected, a connect prompt when its KB isn't connected, else the live chat. */
function MainBody({
  viewerPrefs,
  hasOpenKb,
  activeRootPath,
  onOpenKnowledgeBases,
  onOpenKnowledgeBaseDetails,
  onNewDocument,
  activeSession,
  conn,
  activeResource,
  resourceSession,
  docWidth,
  onDocWidthChange,
  onCloseResource,
  onOpenResource,
  setActiveEntries,
  onResourcesChanged,
  onConnect,
}: {
  viewerPrefs: ViewerPrefs;
  hasOpenKb: boolean;
  activeRootPath: string | null;
  onOpenKnowledgeBases: () => void;
  onOpenKnowledgeBaseDetails: () => void;
  onNewDocument: () => void;
  activeSession: AppChatSession | null;
  conn: KbConnection | undefined;
  activeResource: { id: string; kbUri: string; name: string; presentation: ResourcePresentation } | null;
  resourceSession: ChatSession | null;
  docWidth: number;
  onDocWidthChange: (updater: (prev: number) => number) => void;
  onCloseResource: () => void;
  onOpenResource: (kbUri: string, id: string, name: string, presentation: ResourcePresentation) => void;
  setActiveEntries: (updater: (prev: LogEntry[]) => LogEntry[]) => void;
  onResourcesChanged: () => void;
  onConnect: () => void;
}) {
  // Measure the body so the layout policy (and the divider clamp) work off real width.
  // useLayoutEffect: the first measure lands before paint, so an open doc never flashes
  // full-width before the split kicks in.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el === null) return undefined;
    const measure = () => setContainerWidth(el.getBoundingClientRect().width);
    measure();
    // Both channels: the observer catches sidebar drags (window unchanged, pane resized);
    // the window listener is the belt-and-braces for environments where viewport changes
    // don't reliably tick ResizeObserver.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const layout = mainLayout({
    docOpen: activeResource !== null,
    chatActive: activeSession !== null,
    containerWidth,
    ...(activeResource === null ? {} : { resourcePresentation: activeResource.presentation }),
  });

  // Divider between chat and doc: dragging left widens the doc pane (it hangs off the
  // pane's right edge). Same pointer/keyboard pattern as the sidebar resizer.
  const startDocResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = clampDocWidth(docWidth, containerWidth);
    const onMove = (ev: PointerEvent) =>
      onDocWidthChange(() => clampDocWidth(startW + startX - ev.clientX, containerWidth));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add('resizing');
  };
  const nudgeDocResize = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    onDocWidthChange((w) => clampDocWidth(w + (e.key === 'ArrowLeft' ? 16 : -16), containerWidth));
  };

  // The two pane bodies. The native viewer needs the doc's KB session; if it isn't
  // connected, prompt to close. ResourceView is keyed by id so doc→doc navigation resets
  // its per-document state (pencil, shape, detail card).
  const docBody =
    activeResource === null ? null : resourceSession === null ? (
      <section className="main main--empty">
        <p className="main__hint">This document’s knowledge base isn’t connected.</p>
        <button type="button" className="main__connect" onClick={onCloseResource}>
          Close
        </button>
      </section>
    ) : (
      <ResourceView
        key={activeResource.id}
        session={resourceSession}
        prefs={viewerPrefs}
        resourceId={activeResource.id}
        name={activeResource.name}
        onClose={onCloseResource}
        onOpenResource={(id) => onOpenResource(activeResource.kbUri, id, id, activeResource.presentation)}
      />
    );

  const chatBody =
    !hasOpenKb ? (
      <section className="main main--empty main--welcome">
        <h1>Welcome to Semiont Desktop</h1>
        <p className="main__hint">Open a knowledge base to browse resources and start a chat.</p>
        <button type="button" className="main__connect" onClick={onOpenKnowledgeBases}>Open a Knowledge Base</button>
      </section>
    ) : activeRootPath !== null ? (
      <section className="main main--empty">
        <h1>Knowledge Base not connected</h1>
        <p className="main__hint">This workspace tab is open. Start the KB from Knowledge Base details, then connect it to browse resources and chat.</p>
        <button type="button" className="main__connect" onClick={onOpenKnowledgeBaseDetails}>Open Knowledge Base details</button>
      </section>
    ) : activeSession === null && conn?.opened === undefined ? (
      <section className="main main--empty">
        <h1>Knowledge Base not connected</h1>
        <p className="main__hint">Connect to this KB to browse resources and start a chat.</p>
        <div className="main__actions">
          <button type="button" className="main__connect" onClick={onConnect} disabled={conn?.connecting}>
            {conn?.connecting ? 'Connecting…' : 'Connect'}
          </button>
          <button type="button" className="main__connect main__connect--secondary" onClick={onOpenKnowledgeBaseDetails}>Knowledge Base details</button>
        </div>
        {conn?.error && <p className="main__error" role="alert">{conn.error}</p>}
      </section>
    ) : activeSession === null ? (
      <section className="main main--empty">
        <p className="main__hint">Pick a chat, or start a new one under a knowledge base.</p>
      </section>
    ) : conn?.opened === undefined ? (
      <section className="main main--empty">
        <p className="main__hint">This chat’s knowledge base isn’t connected.</p>
        <button type="button" className="main__connect" onClick={onConnect} disabled={conn?.connecting}>
          {conn?.connecting ? 'Connecting…' : 'Connect'}
        </button>
        {conn?.error && (
          <p className="main__error" role="alert">
            {conn.error}
          </p>
        )}
      </section>
    ) : (
      <ChatPane
        key={activeSession.id}
        session={conn.opened.session}
        prefs={viewerPrefs}
        entries={activeSession.entries}
        setEntries={setActiveEntries}
        onResourcesChanged={onResourcesChanged}
        onOpenResource={(id, name) => onOpenResource(activeSession.kbUri, id, name, 'chat-and-document')}
        onNewDocument={onNewDocument}
      />
    );

  return (
    <div
      ref={bodyRef}
      className="mainbody"
      style={
        layout === 'split'
          ? { gridTemplateColumns: `minmax(0, 1fr) 1px ${clampDocWidth(docWidth, containerWidth)}px` }
          : undefined
      }
    >
      {layout !== 'doc' && chatBody}
      {layout === 'split' && (
        <div
          className="app__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize document pane"
          tabIndex={0}
          onPointerDown={startDocResize}
          onKeyDown={nudgeDocResize}
        />
      )}
      {layout !== 'chat' && docBody}
    </div>
  );
}
