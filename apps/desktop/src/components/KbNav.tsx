import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { KbEntry } from '../lib/user-config';
import type { KbConnection } from '../lib/session';
import { sessionsForKb, sessionTitle, type AppChatSession } from '../lib/chat-sessions';
import { KbResources } from './KbResources';

/** Left nav: every configured KB (connected or not), each expanding to its connect
 *  control, resources, chat sessions, and New Chat. KB add/rename/remove live here.
 *  App owns all state; this renders + dispatches. */
export interface KbNavProps {
  kbs: KbEntry[];
  connections: Record<string, KbConnection>;
  sessions: AppChatSession[];
  activeSessionId: string | null;
  /** The open document's id (purple row), or null when a chat session is active instead. */
  activeResourceId: string | null;
  docsRefresh: number;
  /** Open a document in the main pane. */
  onOpenResource: (kbUri: string, id: string, name: string) => void;
  onAddKb: (kb: KbEntry) => void;
  onRemoveKb: (kbUri: string) => void;
  onRenameKbAlias: (kbUri: string, alias: string) => void;
  onConnect: (kbUri: string) => void;
  onDisconnect: (kbUri: string) => void;
  onNewChat: (kbUri: string) => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenTheme: () => void;
  onOpenLauncherStatus: () => void;
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export function KbNav(props: KbNavProps) {
  const { kbs, onAddKb } = props;
  const [adding, setAdding] = useState(false);

  return (
    <nav className="nav">
      <div className="nav__head">
        <h2 className="nav__title">Knowledge bases</h2>
        <button type="button" className="nav__add" onClick={() => setAdding((v) => !v)} aria-label="Add a knowledge base" title="Add a KB">
          +
        </button>
      </div>

      <div className="nav__content">
        {adding && (
          <AddKbForm
            onAdd={(kb) => {
              onAddKb(kb);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        )}

        {kbs.length === 0 && !adding ? (
          <p className="nav__empty">Add a knowledge base to get started.</p>
        ) : (
          kbs.map((kb) => <KbNavItem key={kb.uri} kb={kb} {...props} />)
        )}
      </div>

      <SemiontMenu onOpenTheme={props.onOpenTheme} onOpenLauncherStatus={props.onOpenLauncherStatus} />
    </nav>
  );
}

function SemiontMenu({ onOpenTheme, onOpenLauncherStatus }: Pick<KbNavProps, 'onOpenTheme' | 'onOpenLauncherStatus'>) {
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
        <div className="semiont-menu" role="menu" aria-label="Semiont menu">
          <button type="button" role="menuitem" onClick={() => choose(onOpenTheme)}>Theme</button>
          <button type="button" role="menuitem" onClick={() => choose(onOpenLauncherStatus)}>Launcher status</button>
        </div>
      )}
      <button
        type="button"
        className="semiont-menu-trigger"
        aria-label="Open Semiont menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
          <path d="m19.4 15 .1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 1 1-4 0V19a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3.8a2 2 0 1 1 0-4H4a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 8 4.5l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5v-.2a2 2 0 1 1 4 0V3a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.5 1 1.7 1.7 0 0 0-.1.2Z" />
        </svg>
        <span className="app__powered-mark">SEMIONT</span>
      </button>
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
    onRemoveKb,
    onRenameKbAlias,
    onConnect,
    onDisconnect,
    onNewChat,
    onSelectSession,
    onRenameSession,
    onDeleteSession,
  } = props;

  const conn = connections[kb.uri];
  const connected = conn?.opened !== undefined;
  const kbSessions = sessionsForKb(sessions, kb.uri);
  const [refreshTick, setRefreshTick] = useState(0);
  const [editingAlias, setEditingAlias] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [docsOpen, setDocsOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(true);

  // The magnifier toggles the search box; opening it expands the panel so the box is visible.
  const toggleSearch = () => {
    const next = !searchOpen;
    setSearchOpen(next);
    if (next) setDocsOpen(true);
  };

  const displayName = (connected && conn?.description?.name) || kb.alias || hostOf(kb.uri);

  return (
    <div className="kb">
      <div className="kb__head">
        {editingAlias ? (
          <InlineEdit
            value={kb.alias ?? ''}
            placeholder={hostOf(kb.uri)}
            onSave={(v) => {
              onRenameKbAlias(kb.uri, v);
              setEditingAlias(false);
            }}
            onCancel={() => setEditingAlias(false)}
          />
        ) : (
          <span className="kb__name" title={kb.uri}>
            {displayName}
            {connected && conn?.description?.gitBranch && <span className="kb__branch">{conn.description.gitBranch}</span>}
          </span>
        )}
        <button type="button" className="kb__icon" onClick={() => setEditingAlias(true)} aria-label="Rename" title="Rename">
          <PencilIcon />
        </button>
        <button type="button" className="kb__icon" onClick={() => setConfirmRemove(true)} aria-label="Remove KB" title="Remove KB">
          <TrashIcon />
        </button>
      </div>

      <div className="kb__conn">
        <button
          type="button"
          className={`kb__connect${connected ? ' kb__connect--on' : ''}`}
          disabled={conn?.connecting}
          onClick={() => (connected ? onDisconnect(kb.uri) : onConnect(kb.uri))}
        >
          {conn?.connecting ? 'Connecting…' : connected ? 'Disconnect' : 'Connect'}
        </button>
      </div>

      {conn?.error && (
        <p className="kb__error" role="alert">
          {conn.error}
        </p>
      )}

      {confirmRemove && (
        <div className="kb__confirm">
          Remove this KB and its {kbSessions.length} chat{kbSessions.length === 1 ? '' : 's'}?
          <button type="button" className="kb__confirm-yes" onClick={() => onRemoveKb(kb.uri)}>
            Remove
          </button>
          <button type="button" className="kb__confirm-no" onClick={() => setConfirmRemove(false)}>
            Cancel
          </button>
        </div>
      )}

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

function AddKbForm({ onAdd, onCancel }: { onAdd: (kb: KbEntry) => void; onCancel: () => void }) {
  const [uri, setUri] = useState('http://localhost:4000');
  const [alias, setAlias] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const kb: KbEntry = { uri: uri.trim() };
    if (alias.trim()) kb.alias = alias.trim();
    if (!kb.uri) return;
    onAdd(kb);
  };

  return (
    <form className="nav__addkb" onSubmit={submit}>
      <input value={uri} onChange={(e) => setUri(e.target.value)} placeholder="http://host:4000" aria-label="KB URL" required />
      <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="alias (optional)" aria-label="Alias" />
      <div className="nav__addkb-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit">Add KB</button>
      </div>
    </form>
  );
}
