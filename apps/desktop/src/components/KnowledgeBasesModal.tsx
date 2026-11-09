import { useEffect } from 'react';
import type { KnowledgeBaseRoot, KnowledgeBasesResult } from '../lib/launcher-bridge';

export type KnowledgeBaseRuntimeStatus = 'checking' | 'running' | 'stopped' | 'attention' | 'unknown';

export interface KnowledgeBaseRow extends KnowledgeBaseRoot {
  status: KnowledgeBaseRuntimeStatus;
  statusDetail?: string;
  gatewayUrl?: string;
  configuredUri?: string;
  activeSessionUri?: string;
  operation?: 'starting' | 'stopping';
  operationError?: string;
}
export type KnowledgeBasesState =
  | { status: 'loading' }
  | { status: 'result'; result: Omit<KnowledgeBasesResult, 'roots'> & { roots: KnowledgeBaseRow[] } };

export function KnowledgeBasesModal({
  state,
  onRefresh,
  onStart,
  onStop,
  onLogin,
  onLogout,
  onClose,
}: {
  state: KnowledgeBasesState;
  onRefresh: () => void;
  onStart: (root: KnowledgeBaseRow) => void;
  onStop: (root: KnowledgeBaseRow) => void;
  onLogin: (root: KnowledgeBaseRow) => void;
  onLogout: (root: KnowledgeBaseRow) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal config--knowledge-bases" role="dialog" aria-modal="true" aria-labelledby="knowledge-bases-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="knowledge-bases-title">Knowledge Bases</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Knowledge Bases">×</button>
        </header>
        <p className="knowledge-bases__intro">Local roots remembered by the launcher. Starting uses each root’s saved settings; Desktop login adds its gateway to the sidebar if needed.</p>
        {state.status === 'loading' ? (
          <p className="knowledge-bases__empty">Reading roots.json…</p>
        ) : (
          <>
            <p className="knowledge-bases__source">{state.result.stateFile}</p>
            {state.result.error !== null ? (
              <pre className="knowledge-bases__error">Could not read roots.json: {state.result.error}</pre>
            ) : state.result.roots.length === 0 ? (
              <p className="knowledge-bases__empty">No local knowledge bases are recorded yet.</p>
            ) : (
              <div className="knowledge-bases__table-wrap">
                <table className="knowledge-bases__table">
                  <thead>
                    <tr>
                      <th scope="col">Knowledge Base</th>
                      <th scope="col">Launcher</th>
                      <th scope="col">Desktop session</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.result.roots.map((root) => (
                      <KnowledgeBaseTableRow key={root.path} root={root} onStart={onStart} onStop={onStop} onLogin={onLogin} onLogout={onLogout} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <footer className="knowledge-bases__footer">
          <button type="button" className="kb__connect" onClick={onRefresh}>Refresh</button>
        </footer>
      </section>
    </div>
  );
}

function KnowledgeBaseTableRow({ root, onStart, onStop, onLogin, onLogout }: {
  root: KnowledgeBaseRow;
  onStart: (root: KnowledgeBaseRow) => void;
  onStop: (root: KnowledgeBaseRow) => void;
  onLogin: (root: KnowledgeBaseRow) => void;
  onLogout: (root: KnowledgeBaseRow) => void;
}) {
  const details = [
    root.did,
    root.lastUsed ? `last used ${root.lastUsed.slice(0, 10)}` : undefined,
    root.lastStarted ? `last started ${root.lastStarted.slice(0, 10)}` : undefined,
    root.config ? `config: ${root.config}` : undefined,
    root.portBlock !== undefined ? `port block ${root.portBlock}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return (
    <tr>
      <td className="knowledge-bases__identity">
        <strong>{root.siteName || root.path.split(/[\\/]/u).filter(Boolean).at(-1) || root.path}</strong>
        <code>{root.path}</code>
        {details.length > 0 && <small>{details.join(' · ')}</small>}
        {root.gatewayUrl !== undefined && <small className="knowledge-bases__gateway">{root.gatewayUrl}</small>}
      </td>
      <td>
        <span className={`knowledge-bases__status knowledge-bases__status--${root.status}`}>
          {statusLabel(root.status)}
        </span>
        {root.statusDetail !== undefined && <small className="knowledge-bases__status-detail">{root.statusDetail}</small>}
      </td>
      <td>
        {root.activeSessionUri !== undefined ? (
          <span className="knowledge-bases__auth knowledge-bases__auth--active">Active</span>
        ) : (
          <span className="knowledge-bases__auth">Not signed in</span>
        )}
      </td>
      <td>
        <div className="knowledge-bases__controls">
          {root.status === 'running' ? (
            <button type="button" className="kb__connect kb__connect--on" disabled={root.operation !== undefined} onClick={() => onStop(root)}>
              {root.operation === 'stopping' ? 'Stopping…' : 'Stop'}
            </button>
          ) : root.status === 'stopped' ? (
            <button type="button" className="kb__connect" disabled={root.operation !== undefined} onClick={() => onStart(root)}>
              {root.operation === 'starting' ? 'Starting…' : 'Start'}
            </button>
          ) : (
            <>
              <button type="button" className="kb__connect" disabled={root.operation !== undefined} onClick={() => onStart(root)}>
                {root.operation === 'starting' ? 'Starting…' : 'Start / repair'}
              </button>
              <button type="button" className="kb__connect kb__connect--on" disabled={root.operation !== undefined} onClick={() => onStop(root)}>
                {root.operation === 'stopping' ? 'Stopping…' : 'Stop'}
              </button>
            </>
          )}
          {root.activeSessionUri !== undefined ? (
            <button type="button" className="kb__connect kb__connect--on" disabled={root.operation !== undefined} onClick={() => onLogout(root)}>Logout</button>
          ) : (
            <button type="button" className="kb__connect" disabled={root.operation !== undefined || root.gatewayUrl === undefined} onClick={() => onLogin(root)}>
              {root.configuredUri === undefined ? 'Add & Login' : 'Login'}
            </button>
          )}
        </div>
        {root.operationError !== undefined && <small className="knowledge-bases__action-error">{root.operationError}</small>}
      </td>
    </tr>
  );
}

function statusLabel(status: KnowledgeBaseRuntimeStatus): string {
  switch (status) {
    case 'checking': return 'Checking…';
    case 'running': return 'Running';
    case 'stopped': return 'Stopped';
    case 'attention': return 'Needs attention';
    case 'unknown': return 'Status unavailable';
  }
}
