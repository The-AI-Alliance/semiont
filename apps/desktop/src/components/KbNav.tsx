import { useEffect, useRef, useState } from 'react';
import type { KbEntry } from '../lib/user-config';
import type { KbConnection } from '../lib/session';
import { sessionsForKb, sessionTitle, type AppChatSession } from '../lib/chat-sessions';
import { KbResources } from './KbResources';
import type { McpProcessStatus } from '../lib/launcher-bridge';
import type { ResourcePresentation } from '../lib/split-layout';
import type { DesktopServiceGroup } from './ServiceGroupModal';
import type { RemoteService } from './RemoteServiceModal';
import { QueueStatusIndicator } from './QueueStatusIndicator';

/** Left nav: the active workspace KB, with its resources and chats.
 *  App owns all state; this renders + dispatches. */
export interface KbNavProps {
  /** Hide KB-specific navigation while the active tab has no SDK session. */
  showWorkspaceContent: boolean;
  kbs: KbEntry[];
  hasLocalRootTab: boolean;
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
  queueRootPath: string | null;
  onOpenDispatcherMessaging: () => void;
}

export interface SemiontMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasActiveKbTab: boolean;
  hasConfiguredIndex: boolean;
  onOpenInference: () => void;
  onOpenServiceGroup: (group: DesktopServiceGroup) => void;
  onOpenRemoteService: (service: RemoteService) => void;
  onOpenSecrets: () => void;
  onOpenMcp: () => void;
  mcpStatus: McpProcessStatus;
  onOpenAppearance: () => void;
  onOpenLanguage: () => void;
  onOpenTelemetry: () => void;
  onOpenRuntime: () => void;
  onOpenKnowledgeBase: () => void;
  onOpenKnowledgeBaseUsers: () => void;
}

export function KbNav(props: KbNavProps) {
  const { kbs } = props;

  return (
    <nav className={`nav${props.showWorkspaceContent ? '' : ' nav--hidden'}`}>
      {props.showWorkspaceContent && (
        <div className="nav__content">
          {kbs.length === 0 ? (
            <div className="nav__empty">
              <p>{props.hasLocalRootTab ? 'This Knowledge Base is not connected yet.' : 'No Knowledge Base tab is open.'}</p>
            </div>
          ) : (
            kbs.map((kb) => <KbNavItem key={kb.uri} kb={kb} {...props} />)
          )}
        </div>
      )}

      <div className="nav__footer">
        {props.showWorkspaceContent && props.queueRootPath !== null && <QueueStatusIndicator rootPath={props.queueRootPath} onClick={props.onOpenDispatcherMessaging} />}
        <div className="semiont-brand" aria-label="Semiont">
          <span className="app__powered-mark">SEMIONT</span>
        </div>
      </div>
    </nav>
  );
}

export function SemiontMenu({ open, onOpenChange, hasActiveKbTab, hasConfiguredIndex, onOpenKnowledgeBase, onOpenKnowledgeBaseUsers, onOpenInference, onOpenServiceGroup, onOpenRemoteService, onOpenSecrets, onOpenMcp, mcpStatus, onOpenAppearance, onOpenLanguage, onOpenTelemetry, onOpenRuntime }: SemiontMenuProps) {
  const menuRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  const choose = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return open ? (
          <aside id="semiont-panel" className="semiont-panel" ref={menuRef} aria-label="Semiont menu">
            <nav className="semiont-panel__items" aria-label="Semiont menu items">
              <section className="semiont-menu__group" aria-labelledby="semiont-menu-app">
                <h2 id="semiont-menu-app">App</h2>
                <button type="button" onClick={() => choose(onOpenLanguage)}><LanguageIcon /><span>Language</span></button>
                <button type="button" onClick={() => choose(onOpenAppearance)}><ThemeIcon /><span>Appearance</span></button>
                <button type="button" onClick={() => choose(onOpenRuntime)}><ContainerIcon /><span>Container runtime</span></button>
                <button type="button" onClick={() => choose(onOpenSecrets)}><SecretsIcon /><span>Secret Managers</span></button>
              </section>
              {hasActiveKbTab && (
                <section className="semiont-menu__group" aria-labelledby="semiont-menu-kb">
                  <h2 id="semiont-menu-kb">Knowledge Base</h2>
                  <button type="button" onClick={() => choose(onOpenKnowledgeBase)}><KnowledgeBaseIcon /><span>Record</span></button>
                  <button type="button" onClick={() => choose(onOpenKnowledgeBaseUsers)}><WorkersIcon /><span>Users</span></button>
                  <button type="button" onClick={() => choose(() => onOpenServiceGroup('gateway-archivist'))}><RecordIcon /><span>Gateway &amp; Archivist</span></button>
                  <button type="button" onClick={() => choose(() => onOpenServiceGroup('dispatcher-messaging'))}><RecordIcon /><span>Dispatcher &amp; Messaging</span></button>
                  {hasConfiguredIndex && <button type="button" onClick={() => choose(() => onOpenServiceGroup('index'))}><IndexIcon /><span>Index</span></button>}
                </section>
              )}
              <section className="semiont-menu__group" aria-labelledby="semiont-menu-shared">
                <h2 id="semiont-menu-shared">Shared, Local Services</h2>
                <button type="button" onClick={() => choose(onOpenInference)}><InferenceIcon /><span>Inference &amp; Embedding</span></button>
                <button type="button" onClick={() => choose(() => onOpenServiceGroup('knowledge-workers'))}><WorkersIcon /><span>Knowledge Workers</span></button>
                <button type="button" onClick={() => choose(() => onOpenServiceGroup('browser'))}><BrowserIcon /><span>Browser</span></button>
                <button type="button" onClick={() => choose(() => onOpenServiceGroup('issuer'))}><IdentityIcon /><span>Identity &amp; Stores</span></button>
                <button type="button" onClick={() => choose(onOpenMcp)}>
                  <McpIcon running={mcpStatus.state === 'running'} />
                  <span className="semiont-menu__item-copy">
                    <span>MCP</span>
                    {mcpStatus.state === 'running' && mcpStatus.pid !== null && <small>Running · PID {mcpStatus.pid}</small>}
                    {mcpStatus.state !== 'running' && <small>{mcpStatus.state === 'failed' ? 'Failed' : 'Stopped'}</small>}
                  </span>
                </button>
                <button type="button" onClick={() => choose(onOpenTelemetry)}><TelemetryIcon /><span>Telemetry</span></button>
              </section>
              <section className="semiont-menu__group" aria-labelledby="semiont-menu-remote">
                <h2 id="semiont-menu-remote">Shared, Remote Services</h2>
                <button type="button" onClick={() => choose(() => onOpenRemoteService('inference'))}><InferenceIcon /><span>Inference &amp; Embedding</span></button>
                <button type="button" onClick={() => choose(() => onOpenRemoteService('knowledge-workers'))}><WorkersIcon /><span>Knowledge Workers</span></button>
                <button type="button" onClick={() => choose(() => onOpenRemoteService('identity'))}><IdentityIcon /><span>Identity</span></button>
              </section>
            </nav>
          </aside>
  ) : null;
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
  const [docsOpen, setDocsOpen] = useState(true);
  const [sessionsOpen, setSessionsOpen] = useState(true);

  return (
    <div className="kb">
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
          </div>
          {docsOpen && (
            <KbResources
              session={conn.opened.session}
              refreshSignal={docsRefresh}
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

function KnowledgeBaseIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <path d="M4 5.5c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2Z" />
      <path d="M4 5.5v6c0 1.1 3.6 2 8 2m8-8v3m-16-3v6m0 0c0 1.1 3.6 2 8 2m8-5v5c0 1.1-3.6 2-8 2m-8-4v5c0 1.1 3.6 2 8 2" />
    </svg>
  );
}

function RecordIcon() {
  return <svg width="18" height="18" {...ICON_PROPS}><path d="M4 5.5c0-1 3.6-2 8-2s8 1 8 2-3.6 2-8 2-8-1-8-2Z" /><path d="M4 5.5v6c0 1 3.6 2 8 2m8-8v6m-16 0v5c0 1 3.6 2 8 2" /></svg>;
}

function IndexIcon() {
  return <svg width="18" height="18" {...ICON_PROPS}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4M8 10.5h5M10.5 8v5" /></svg>;
}

function WorkersIcon() {
  return <svg width="18" height="18" {...ICON_PROPS}><circle cx="9" cy="8" r="3" /><path d="M3 20v-1a6 6 0 0 1 12 0v1m2-13a3 3 0 0 1 0 6m1 2a5 5 0 0 1 3 4v1" /></svg>;
}

function BrowserIcon() {
  return <svg width="18" height="18" {...ICON_PROPS}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /><circle cx="12" cy="14" r="2.5" /><path d="M9.5 14h5m-2.5-2.5a5 5 0 0 1 0 5" /></svg>;
}

function IdentityIcon() {
  return <svg width="18" height="18" {...ICON_PROPS}><rect x="3" y="5" width="18" height="15" rx="2" /><circle cx="9" cy="11" r="2" /><path d="M5.5 17a3.5 3.5 0 0 1 7 0m3-6h3m-3 4h3M8 5V3h8v2" /></svg>;
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

function LanguageIcon() {
  return (
    <svg width="18" height="18" {...ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18m0-18a15 15 0 0 0 0 18" />
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`kb__chevron${open ? ' kb__chevron--open' : ''}`} width="10" height="10" {...ICON_PROPS}>
      <polyline points="9 6 15 12 9 18" />
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
