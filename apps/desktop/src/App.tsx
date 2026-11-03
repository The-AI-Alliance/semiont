import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ClickAction, SelectionMotivation } from '@semiont/react-ui';
import type { OpenedSession, SessionEndReason } from '@semiont/sdk';
import { appTitle } from 'virtual:app-config';
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
import { CHAT_MIN, DOC_DEFAULT, clampDocWidth, mainLayout } from './lib/split-layout';
import { KbNav } from './components/KbNav';
import { SettingsPanel } from './components/SettingsPanel';
import { AppFooter, type KbDisplay } from './components/AppFooter';
import { ChatPane, type LogEntry } from './components/ChatPane';
import { ResourceView } from './components/ResourceView';
import type { ViewerPrefs } from './components/ViewerPrefControls';

// In Electron the preload exposes window.configBridge; the web build has no such bridge.
const isElectron = typeof window !== 'undefined' && window.configBridge !== undefined;

// Resizable sidebar: width in px, clamped and persisted via prefs (XDG file in
// Electron, localStorage on the web).
const SIDEBAR_KEY = 'sidebar-width';
const DOC_WIDTH_KEY = 'doc-pane-width';
const ACTIVE_SESSION_KEY = 'active-session-id';
const CLICK_ACTION_KEY = 'viewer-click-action';
const MOTIVATION_KEY = 'viewer-motivation';
const CONNECTED_KBS_KEY = 'connected-kb-uris';
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 272; // 17rem
const clampWidth = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));

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

export function App() {
  const [config, setConfig] = useState<UserConfig | null>(null); // null = still loading
  // One live connection per connected KB (its own token-refreshing SemiontSession).
  const [connections, setConnections] = useState<Record<string, KbConnection>>({});
  const [sessions, setSessions] = useState<AppChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // The document shown in the main pane. It coexists with the active chat: when both are
  // set and the pane is wide enough, the main pane splits (chat left, document right).
  const [activeResource, setActiveResource] = useState<{ id: string; kbUri: string; name: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<Theme>('system');

  // App-global viewer prefs (TOOLBAR-PREFS-AS-PROPS): click action + selection motivation are
  // app settings (footer controls by the gear), passed as controlled props to every mounted
  // viewer. Mode is per-message (each MessageView's pencil); shape stays per-instance.
  const [clickAction, setClickAction] = useState<ClickAction>('follow');
  const [motivation, setMotivation] = useState<SelectionMotivation | null>('linking');
  useEffect(() => {
    void getPref<ClickAction>(CLICK_ACTION_KEY, 'follow').then(setClickAction);
    void getPref<SelectionMotivation>(MOTIVATION_KEY, 'linking').then(setMotivation);
  }, []);
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
  // Bumped when the chat pane creates a resource, to nudge document lists to re-fetch.
  const [docsRefresh, setDocsRefresh] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR_DEFAULT);
  // Split-view document-pane width (px), persisted like the sidebar; clamped at render
  // against the measured pane so a stale saved value can't starve the chat column.
  const [docWidth, setDocWidth] = useState<number>(DOC_DEFAULT);
  const sidebarLoaded = useRef(false);
  const docWidthLoaded = useRef(false);
  const sessionsLoaded = useRef(false);
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

  const saveConfig = (next: UserConfig) => {
    setConfig(next);
    void saveUserConfig(next);
  };

  // Connect to one KB and hold its live session. Multiple KBs can be connected at once,
  // each with its own token-renewal lifecycle. Reconnecting replaces any stale state.
  // `interactive` is whether the person may be sent to the issuer to sign in: the Connect
  // button's yes, a launch's no (a launch resumes stored sessions and opens nothing).
  const connectKb = async (kbUri: string, interactive: boolean) => {
    const kb = config?.kbs.find((k) => k.uri === kbUri);
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

  // On launch, once the config is in: load sessions + the last active session, and
  // auto-reconnect the KBs that were connected last run (those still in the config).
  useEffect(() => {
    if (config === null || bootstrapped.current) return;
    bootstrapped.current = true;
    void (async () => {
      const [loaded, savedActive, connectedUris] = await Promise.all([
        loadSessions(),
        getPref<string | null>(ACTIVE_SESSION_KEY, null),
        getPref<string[]>(CONNECTED_KBS_KEY, []),
      ]);
      setSessions(loaded);
      if (savedActive && loaded.some((s) => s.id === savedActive)) setActiveSessionId(savedActive);
      sessionsLoaded.current = true;
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

  // Remember which KBs are connected, to auto-reconnect them next launch.
  useEffect(() => {
    if (!bootstrapped.current) return;
    const connected = Object.entries(connections)
      .filter(([, c]) => c.opened !== undefined)
      .map(([uri]) => uri);
    void setPref(CONNECTED_KBS_KEY, connected);
  }, [connections]);

  // --- KB CRUD (config) ---
  const handleAddKb = (kb: KbEntry) => {
    if (config === null) return;
    saveConfig({ ...config, kbs: [...config.kbs.filter((k) => k.uri !== kb.uri), kb] });
  };
  const handleRemoveKb = (kbUri: string) => {
    if (config === null) return;
    disconnectKb(kbUri);
    saveConfig({ ...config, kbs: config.kbs.filter((k) => k.uri !== kbUri) });
    const remaining = sessions.filter((s) => s.kbUri !== kbUri);
    setSessions(remaining);
    if (activeSessionId && !remaining.some((s) => s.id === activeSessionId)) setActiveSessionId(null);
  };
  const handleRenameKbAlias = (kbUri: string, alias: string) => {
    if (config === null) return;
    saveConfig({ ...config, kbs: config.kbs.map((k) => (k.uri === kbUri ? withAlias(k, alias) : k)) });
  };

  // --- Session CRUD ---
  const handleNewChat = (kbUri: string) => {
    const s = newSession(kbUri);
    setSessions((prev) => [...prev, s]);
    setActiveSessionId(s.id); // any open document stays put (split view)
  };
  const handleRenameSession = (id: string, name: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name: name.trim() ? name.trim() : null, updatedAt: Date.now() } : s)),
    );
  };
  const handleDeleteSession = (id: string) => {
    const target = sessions.find((s) => s.id === id);
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    if (activeSessionId === id) {
      const sameKb = target ? sessionsForKb(remaining, target.kbUri) : [];
      setActiveSessionId(sameKb[0]?.id ?? null);
    }
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
  const openResource = (kbUri: string, id: string, name: string) => setActiveResource({ kbUri, id, name });
  // Selecting a chat session leaves any open document in place (split view).
  const selectSession = (id: string) => setActiveSessionId(id);

  if (config === null) return <p className="app__connecting">Loading…</p>;

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeKbUri = activeSession?.kbUri ?? null;
  const activeConn = activeKbUri ? connections[activeKbUri] : undefined;

  // The footer describes the active chat's KB (the composer's context); with no chat
  // selected it falls back to the open document's. Null hides the status line; the pref
  // controls + gear always render. (In a split the doc pane's header names the doc — a
  // doc from ANOTHER KB is identified there, not here.)
  const footerKbUri = activeKbUri ?? activeResource?.kbUri ?? null;
  const footerConn = footerKbUri !== null ? connections[footerKbUri] : undefined;
  let footerKb: KbDisplay | null = null;
  if (footerKbUri !== null && footerConn?.opened !== undefined) {
    const alias = config.kbs.find((k) => k.uri === footerKbUri)?.alias ?? null;
    const description = footerConn.description;
    footerKb = {
      name: description?.name ?? alias ?? hostOf(footerKbUri),
      branch: description?.gitBranch ?? null,
      // show the alias separately only when it isn't already standing in as the name
      alias: description !== undefined && alias !== null ? alias : null,
    };
  }

  return (
    <>
      <div className={isElectron ? 'app app--electron' : 'app'}>
        {isElectron && <div className="app__dragbar" aria-hidden="true" />}
        <div className="app__body" style={{ gridTemplateColumns: `${sidebarWidth}px 1px 1fr` }}>
          <KbNav
            kbs={config.kbs}
            connections={connections}
            sessions={sessions}
            // doc and chat coexist now — both rows light up when both are live
            activeSessionId={activeSessionId}
            activeResourceId={activeResource?.id ?? null}
            docsRefresh={docsRefresh}
            onOpenResource={openResource}
            onAddKb={handleAddKb}
            onRemoveKb={handleRemoveKb}
            onRenameKbAlias={handleRenameKbAlias}
            onConnect={(uri) => void connectKb(uri, true)}
            onDisconnect={disconnectKb}
            onNewChat={handleNewChat}
            onSelectSession={selectSession}
            onRenameSession={handleRenameSession}
            onDeleteSession={handleDeleteSession}
          />
          <div
            className="app__resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={nudgeResize}
          />
          <MainPane
            viewerPrefs={viewerPrefs}
            footerKb={footerKb}
            activeSession={activeSession}
            conn={activeConn}
            activeResource={activeResource}
            resourceSession={activeResource ? connections[activeResource.kbUri]?.opened?.session ?? null : null}
            docWidth={docWidth}
            onDocWidthChange={setDocWidth}
            onCloseResource={() => setActiveResource(null)}
            onOpenResource={openResource}
            setActiveEntries={setActiveEntries}
            onResourcesChanged={() => setDocsRefresh((n) => n + 1)}
            onOpenSettings={() => setShowSettings(true)}
            onConnect={() => activeKbUri && void connectKb(activeKbUri, true)}
          />
        </div>
      </div>
      {showSettings && (
        <SettingsPanel theme={theme} onThemeChange={setTheme} onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}

/** The right pane: the current body (document / chat / split) over the app footer —
 *  the footer (KB status, viewer pref controls, Settings gear) persists across ALL of them. */
function MainPane({
  viewerPrefs,
  footerKb,
  onOpenSettings,
  ...body
}: {
  viewerPrefs: ViewerPrefs;
  /** The KB the pane is showing (active chat's, else open document's); null hides the line. */
  footerKb: KbDisplay | null;
  onOpenSettings: () => void;
  activeSession: AppChatSession | null;
  conn: KbConnection | undefined;
  activeResource: { id: string; kbUri: string; name: string } | null;
  /** The connected session for the open document's KB (null if that KB isn't connected). */
  resourceSession: ChatSession | null;
  docWidth: number;
  onDocWidthChange: (updater: (prev: number) => number) => void;
  onCloseResource: () => void;
  onOpenResource: (kbUri: string, id: string, name: string) => void;
  setActiveEntries: (updater: (prev: LogEntry[]) => LogEntry[]) => void;
  onResourcesChanged: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="mainwrap">
      <MainBody viewerPrefs={viewerPrefs} {...body} />
      <AppFooter kb={footerKb} prefs={viewerPrefs} onOpenSettings={onOpenSettings} />
    </div>
  );
}

/** The main pane's body. An open document splits the pane beside an active chat when there's
 *  room (`mainLayout`); too narrow — or no chat — and the document takes the whole pane (the
 *  original swap). Chat-side states: empty when no chat is selected, a connect prompt when
 *  the selected chat's KB isn't connected, else the live chat. */
function MainBody({
  viewerPrefs,
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
  activeSession: AppChatSession | null;
  conn: KbConnection | undefined;
  activeResource: { id: string; kbUri: string; name: string } | null;
  resourceSession: ChatSession | null;
  docWidth: number;
  onDocWidthChange: (updater: (prev: number) => number) => void;
  onCloseResource: () => void;
  onOpenResource: (kbUri: string, id: string, name: string) => void;
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
        onOpenResource={(id) => onOpenResource(activeResource.kbUri, id, id)}
      />
    );

  const chatBody =
    activeSession === null ? (
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
        onOpenResource={(id, name) => onOpenResource(activeSession.kbUri, id, name)}
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
