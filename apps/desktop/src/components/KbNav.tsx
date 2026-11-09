import { useEffect, useRef, useState } from 'react';
import type { KbEntry } from '../lib/user-config';
import type { KbConnection } from '../lib/session';
import { sessionsForKb, sessionTitle, type AppChatSession } from '../lib/chat-sessions';
import { KbResources } from './KbResources';
import type { McpProcessStatus } from '../lib/launcher-bridge';

/** Left nav: the active workspace KB, with its resources and chats.
 *  App owns all state; this renders + dispatches. */
export interface KbNavProps {
  kbs: KbEntry[];
  hasLocalRootTab: boolean;
  connections: Record<string, KbConnection>;
  sessions: AppChatSession[];
  activeSessionId: string | null;
  /** The open document's id (purple row), or null when a chat session is active instead. */
  activeResourceId: string | null;
  docsRefresh: number;
  /** Open a document in the main pane. */
  onOpenResource: (kbUri: string, id: string, name: string) => void;
  onNewChat: (kbUri: string) => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenAbout: () => void;
  onOpenInference: () => void;
  onOpenSecrets: () => void;
  onOpenMcp: () => void;
  mcpStatus: McpProcessStatus;
  onOpenTheme: () => void;
  onOpenLauncherStatus: () => void;
  onOpenKnowledgeBases: (path?: string) => void;
  onOpenTelemetry: () => void;
  onOpenRuntime: () => void;
  onOpenGit: () => void;
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

      <SemiontMenu onOpenAbout={props.onOpenAbout} onOpenInference={props.onOpenInference} onOpenSecrets={props.onOpenSecrets} onOpenMcp={props.onOpenMcp} mcpStatus={props.mcpStatus} onOpenTheme={props.onOpenTheme} onOpenLauncherStatus={props.onOpenLauncherStatus} onOpenKnowledgeBases={props.onOpenKnowledgeBases} onOpenTelemetry={props.onOpenTelemetry} onOpenRuntime={props.onOpenRuntime} onOpenGit={props.onOpenGit} />
    </nav>
  );
}

function SemiontMenu({ onOpenAbout, onOpenInference, onOpenSecrets, onOpenMcp, mcpStatus, onOpenTheme, onOpenLauncherStatus, onOpenKnowledgeBases, onOpenTelemetry, onOpenRuntime, onOpenGit }: Pick<KbNavProps, 'onOpenAbout' | 'onOpenInference' | 'onOpenSecrets' | 'onOpenMcp' | 'mcpStatus' | 'onOpenTheme' | 'onOpenLauncherStatus' | 'onOpenKnowledgeBases' | 'onOpenTelemetry' | 'onOpenRuntime' | 'onOpenGit'>) {
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
              <button type="button" onClick={() => choose(onOpenKnowledgeBases)}><KnowledgeBasesIcon /><span>Knowledge Bases</span></button>
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
          <span className="semiont-panel-toggle__s">S</span><span aria-hidden="true">‹</span>
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
    onSelectSession,
    onRenameSession,
    onDeleteSession,
  } = props;

  const conn = connections[kb.uri];
  const connected = conn?.opened !== undefined;
  const kbSessions = sessionsForKb(sessions, kb.uri);
  const [refreshTick, setRefreshTick] = useState(0);
  const [docsOpen, setDocsOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(true);

  // The magnifier toggles the search box; opening it expands the panel so the box is visible.
  const toggleSearch = () => {
    const next = !searchOpen;
    setSearchOpen(next);
    if (next) setDocsOpen(true);
  };

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
              className={`kb__icon${searchOpen ? ' kb__icon--active' : ''}`}
              onClick={toggleSearch}
              aria-label="Search documents"
              aria-pressed={searchOpen}
              title="Search documents"
            >
              <SearchIcon />
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
              searchOpen={searchOpen}
              refreshSignal={refreshTick + docsRefresh}
              activeResourceId={activeResourceId}
              onOpen={(id, name) => onOpenResource(kb.uri, id, name)}
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
                  onRename={(name) => onRenameSession(s.id, name)}
                  onDelete={() => onDeleteSession(s.id)}
                />
              ))}
            </ul>
            <button type="button" className="kb__newchat" onClick={() => onNewChat(kb.uri)}>
              + New Chat
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: AppChatSession;
  active: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (editing) {
    return (
      <li className="kb__session">
        <InlineEdit
          value={session.name ?? sessionTitle(session)}
          placeholder="Chat name"
          onSave={(v) => {
            onRename(v);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className={`kb__session${active ? ' kb__session--active' : ''}`}>
      <button type="button" className="kb__session-name" onClick={onSelect} title={sessionTitle(session)}>
        {sessionTitle(session)}
      </button>
      {confirming ? (
        <span className="kb__session-confirm">
          <button type="button" className="kb__confirm-yes" onClick={onDelete}>
            Delete
          </button>
          <button type="button" className="kb__confirm-no" onClick={() => setConfirming(false)}>
            ×
          </button>
        </span>
      ) : (
        <>
          <button type="button" className="kb__icon" onClick={() => setEditing(true)} aria-label="Rename chat" title="Rename">
            <PencilIcon />
          </button>
          <button type="button" className="kb__icon" onClick={() => setConfirming(true)} aria-label="Delete chat" title="Delete">
            <TrashIcon />
          </button>
        </>
      )}
    </li>
  );
}

function InlineEdit({
  value,
  placeholder,
  onSave,
  onCancel,
}: {
  value: string;
  placeholder: string;
  onSave: (v: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <input
      className="kb__edit"
      autoFocus
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onSave(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSave(draft.trim());
        if (e.key === 'Escape') onCancel();
      }}
    />
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

function KnowledgeBasesIcon() {
  return <svg width="18" height="18" viewBox="0 0 20 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 3.5A2.5 2.5 0 0 1 3.5 1H8l2 2h6.5A2.5 2.5 0 0 1 19 5.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 1 12.5v-9Z" /></svg>;
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

function SearchIcon() {
  return (
    <svg width="14" height="14" {...ICON_PROPS}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" {...ICON_PROPS}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" {...ICON_PROPS}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
