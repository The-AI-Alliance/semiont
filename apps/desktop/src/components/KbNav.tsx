import { useEffect, useRef, useState } from 'react';
import type { KbEntry } from '../lib/user-config';
import type { KbConnection } from '../lib/session';
import { sessionsForKb, sessionTitle, type AppChatSession } from '../lib/chat-sessions';
import { KbResources } from './KbResources';
import type { McpProcessStatus } from '../lib/launcher-bridge';
import type { ResourcePresentation } from '../lib/split-layout';

/** Left nav: the active workspace KB, with its resources and chats.
 *  App owns all state; this renders + dispatches. */
export interface KbNavProps {
  kbs: KbEntry[];
  hasLocalRootTab: boolean;
  hasActiveKbTab: boolean;
  connections: Record<string, KbConnection>;
  sessions: AppChatSession[];
  activeSessionId: string | null;
  /** The open document's id (purple row), or null when a chat session is active instead. */
  activeResourceId: string | null;
  docsRefresh: number;
  /** Open a document in the main pane. */
  onOpenResource: (kbUri: string, id: string, name: string, presentation: ResourcePresentation) => void;
  onNewChat: (kbUri: string) => void;
  onNewDocument: (kbUri: string) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenAbout: () => void;
  onOpenInference: () => void;
  onOpenSecrets: () => void;
  onOpenMcp: () => void;
  mcpStatus: McpProcessStatus;
  onOpenTheme: () => void;
  onOpenLauncherStatus: () => void;
  onOpenTelemetry: () => void;
  onOpenRuntime: () => void;
  onOpenGit: () => void;
  onOpenKnowledgeBase: () => void;
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export function KbNav(props: KbNavProps) {
  const { kbs } = props;

  return (
    <nav className="nav">
      <div className="nav__content">
        {kbs.length === 0 ? (
          <div className="nav__empty">
            <p>{props.hasLocalRootTab ? 'This Knowledge Base is not connected yet.' : 'No Knowledge Base tab is open.'}</p>
          </div>
        ) : (
          kbs.map((kb) => <KbNavItem key={kb.uri} kb={kb} {...props} />)
        )}
      </div>

      <SemiontMenu hasActiveKbTab={props.hasActiveKbTab} onOpenKnowledgeBase={props.onOpenKnowledgeBase} onOpenAbout={props.onOpenAbout} onOpenInference={props.onOpenInference} onOpenSecrets={props.onOpenSecrets} onOpenMcp={props.onOpenMcp} mcpStatus={props.mcpStatus} onOpenTheme={props.onOpenTheme} onOpenLauncherStatus={props.onOpenLauncherStatus} onOpenTelemetry={props.onOpenTelemetry} onOpenRuntime={props.onOpenRuntime} onOpenGit={props.onOpenGit} />
    </nav>
  );
}

function SemiontMenu({ hasActiveKbTab, onOpenKnowledgeBase, onOpenAbout, onOpenInference, onOpenSecrets, onOpenMcp, mcpStatus, onOpenTheme, onOpenLauncherStatus, onOpenTelemetry, onOpenRuntime, onOpenGit }: Pick<KbNavProps, 'hasActiveKbTab' | 'onOpenKnowledgeBase' | 'onOpenAbout' | 'onOpenInference' | 'onOpenSecrets' | 'onOpenMcp' | 'mcpStatus' | 'onOpenTheme' | 'onOpenLauncherStatus' | 'onOpenTelemetry' | 'onOpenRuntime' | 'onOpenGit'>) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="nav__footer" ref={menuRef}>
      {open && (
        <>
          <button type="button" className="semiont-panel-backdrop" aria-label="Close Semiont panel" onClick={() => setOpen(false)} />
          <aside id="semiont-panel" className="semiont-panel" role="dialog" aria-modal="true" aria-label="Semiont menu">
            <header className="semiont-panel__header">
              <button type="button" className="semiont-panel-toggle semiont-panel-toggle--open" onClick={() => setOpen(false)} aria-label="Collapse Semiont panel" aria-expanded="true" aria-controls="semiont-panel">
                <span className="app__powered-mark">SEMIONT</span><span aria-hidden="true">›</span>
              </button>
            </header>
            <nav className="semiont-panel__items">
              {hasActiveKbTab && <button type="button" onClick={() => choose(onOpenKnowledgeBase)}><KnowledgeBaseIcon /><span>Knowledge Base</span></button>}
              <button type="button" onClick={() => choose(onOpenAbout)}><AboutIcon /><span>About</span></button>
              <button type="button" onClick={() => choose(onOpenInference)}><InferenceIcon /><span>Inference</span></button>
              <button type="button" onClick={() => choose(onOpenSecrets)}><SecretsIcon /><span>Secrets</span></button>
              <button type="button" onClick={() => choose(onOpenMcp)}>
                <McpIcon running={mcpStatus.state === 'running'} />
                <span className="semiont-menu__item-copy">
                  <span>MCP</span>
                  {mcpStatus.state === 'running' && mcpStatus.pid !== null && <small>Running · PID {mcpStatus.pid}</small>}
                  {mcpStatus.state !== 'running' && <small>{mcpStatus.state === 'failed' ? 'Failed' : 'Stopped'}</small>}
                </span>
              </button>
              <button type="button" onClick={() => choose(onOpenTheme)}><ThemeIcon /><span>Theme</span></button>
              <button type="button" onClick={() => choose(onOpenTelemetry)}><TelemetryIcon /><span>Telemetry</span></button>
              <button type="button" onClick={() => choose(onOpenRuntime)}><ContainerIcon /><span>Container runtime</span></button>
              <button type="button" onClick={() => choose(onOpenGit)}><GitIcon /><span>Git</span></button>
              <button type="button" onClick={() => choose(onOpenLauncherStatus)}><StatusIcon /><span>Status</span></button>
            </nav>
          </aside>
        </>
      )}
      {!open && (
        <button
          type="button"
          className="semiont-panel-toggle semiont-panel-toggle--collapsed"
          aria-label="Open Semiont panel"
          aria-haspopup="dialog"
          aria-controls="semiont-panel"
          aria-expanded="false"
          onClick={() => setOpen(true)}
        >
          <GearIcon /><span aria-hidden="true">‹</span>
        </button>
      )}
      <div className="semiont-brand" aria-label="Semiont">
        <span className="app__powered-mark">SEMIONT</span>
      </div>
    </div>
  );
}

function KbNavItem({ kb, ...props }: { kb: KbEntry } & KbNavProps) {
  const {
    connections,
    sessions,
    activeSessionId,
    activeResourceId,
    docsRefresh,
    onOpenResource,
    onNewChat,
    onNewDocument,
    onSelectSession,
  } = props;

  const conn = connections[kb.uri];
  const connected = conn?.opened !== undefined;
  const kbSessions = sessionsForKb(sessions, kb.uri);
  const [refreshTick, setRefreshTick] = useState(0);
  const [docsOpen, setDocsOpen] = useState(true);
  const [sessionsOpen, setSessionsOpen] = useState(true);

  const displayName = kb.alias || (connected && conn?.description?.name) || hostOf(kb.uri);

  return (
    <div className="kb">
      <div className="kb__head">
        <span className="kb__name" title={kb.uri}>
          {displayName}
          {connected && conn?.description?.gitBranch && <span className="kb__branch">{conn.description.gitBranch}</span>}
        </span>
      </div>

      {connected && conn?.opened && (
        <div className="kb__section-group">
          <div className="kb__section-head">
            <button
              type="button"
              className="kb__section-toggle"
              onClick={() => setDocsOpen((v) => !v)}
              aria-expanded={docsOpen}
              title={docsOpen ? 'Collapse documents' : 'Expand documents'}
            >
              <Chevron open={docsOpen} />
              Documents
            </button>
            <button
              type="button"
              className="kb__icon"
              onClick={() => onNewDocument(kb.uri)}
              aria-label="Add document"
              title="Add document"
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="kb__icon"
              onClick={() => setRefreshTick((t) => t + 1)}
              aria-label="Refresh documents"
              title="Refresh documents"
            >
              <RefreshIcon />
            </button>
          </div>
          {docsOpen && (
            <KbResources
              session={conn.opened.session}
              refreshSignal={refreshTick + docsRefresh}
              activeResourceId={activeResourceId}
              onOpen={(id, name) => onOpenResource(kb.uri, id, name, 'document-only')}
            />
          )}
        </div>
      )}

      <div className="kb__section-group">
        <div className="kb__section-head">
          <button
            type="button"
            className="kb__section-toggle"
            onClick={() => setSessionsOpen((v) => !v)}
            aria-expanded={sessionsOpen}
            title={sessionsOpen ? 'Collapse chats' : 'Expand chats'}
          >
            <Chevron open={sessionsOpen} />
            Chats
          </button>
          <button
            type="button"
            className="kb__icon"
            onClick={() => onNewChat(kb.uri)}
            aria-label="New chat"
            title="New chat"
          >
            <PlusIcon />
          </button>
        </div>
        {sessionsOpen && (
          <>
            <ul className="kb__sessions">
              {kbSessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  onSelect={() => onSelectSession(s.id)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function SessionRow({ session, active, onSelect }: {
  session: AppChatSession;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li className={`kb__session${active ? ' kb__session--active' : ''}`}>
      <button type="button" className="kb__session-name" onClick={onSelect} title={sessionTitle(session)}>
        {sessionTitle(session)}
      </button>
    </li>
  );
}

// Small stroked glyphs (Feather-style) for the per-KB and per-session controls.
const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function AboutIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5m0-8h.01" />
    </svg>
  );
}

function KnowledgeBaseIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <path d="M4 5.5c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2Z" />
      <path d="M4 5.5v6c0 1.1 3.6 2 8 2m8-8v3m-16-3v6m0 0c0 1.1 3.6 2 8 2m8-5v5c0 1.1-3.6 2-8 2m-8-4v5c0 1.1 3.6 2 8 2" />
    </svg>
  );
}

function InferenceIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <path d="M12 3a7 7 0 0 0-4 12.75V19h8v-3.25A7 7 0 0 0 12 3Z" />
      <path d="M9 22h6m-3-15v4m-2-2h4" />
    </svg>
  );
}

function SecretsIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <rect x="3" y="10" width="18" height="11" rx="2" />
      <path d="M7 10V7a5 5 0 0 1 10 0v3m-5 5v2" />
    </svg>
  );
}

function McpIcon({ running }: { running: boolean }) {
  return (
    <svg className={running ? 'semiont-menu__mcp-icon--running' : undefined} width="18" height="18" {...ICON_PROPS}>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="6" cy="17" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="m10.8 7.2-3.6 7.6m6-7.6 3.6 7.6M8.5 17h7" />
    </svg>
  );
}

function ThemeIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </svg>
  );
}

function TelemetryIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <path d="M3 3v18h18M8 16v-4m5 4V7m5 9V4" />
    </svg>
  );
}

function ContainerIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <path d="m12 3 9 5v8l-9 5-9-5V8l9-5Zm0 10 9-5M12 13 3 8m9 5v8M7.5 5.5l9 5" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M6 7v10m12-10a8 8 0 0 1-8 8H6" />
    </svg>
  );
}

function StatusIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <circle cx="12" cy="12" r="10" />
      <path d="M4 12h4l2-4 4 8 2-4h4" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.69 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.69a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.31 9c.36.6.99 1 1.69 1h.09a2 2 0 1 1 0 4H21a1.65 1.65 0 0 0-1.6 1Z" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`kb__chevron${open ? ' kb__chevron--open' : ''}`} width="10" height="10" {...ICON_PROPS}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" {...ICON_PROPS}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" {...ICON_PROPS}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
