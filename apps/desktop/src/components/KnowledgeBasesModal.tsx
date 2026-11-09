import { useEffect, useState } from 'react';
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const roots = state.status === 'result' && state.result.error === null ? state.result.roots : [];
  useEffect(() => {
    setSelectedPath((current) => current !== null && roots.some((root) => root.path === current)
      ? current
      : roots[0]?.path ?? null);
  }, [roots]);
  const selected = roots.find((root) => root.path === selectedPath) ?? roots[0];

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal config--knowledge-bases" role="dialog" aria-modal="true" aria-labelledby="knowledge-bases-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="knowledge-bases-title">Knowledge Bases</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Knowledge Bases">×</button>
        </header>
        <p className="knowledge-bases__intro">Choose a local root to see its launcher state, Desktop session, and controls. Starting uses the root’s saved launcher settings.</p>
        {state.status === 'loading' ? (
          <p className="knowledge-bases__empty">Reading roots.json…</p>
        ) : (
          <>
            <p className="knowledge-bases__source">{state.result.stateFile}</p>
            {state.result.error !== null ? (
              <pre className="knowledge-bases__error">Could not read roots.json: {state.result.error}</pre>
            ) : roots.length === 0 ? (
              <p className="knowledge-bases__empty">No local knowledge bases are recorded yet.</p>
            ) : (
              <div className="knowledge-bases__workspace">
                <div className="knowledge-bases__table-wrap">
                  <table className="knowledge-bases__table">
                    <thead>
                      <tr>
                        <th scope="col">Knowledge Base</th>
                        <th scope="col">Last Used</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roots.map((root) => (
                        <tr className={selected?.path === root.path ? 'knowledge-bases__row--selected' : undefined} key={root.path}>
                          <td>
                            <button
                              type="button"
                              className="knowledge-bases__select"
                              aria-pressed={selected?.path === root.path}
                              onClick={() => setSelectedPath(root.path)}
                            >
                              <strong>{root.siteName || root.path.split(/[\\/]/u).filter(Boolean).at(-1) || root.path}</strong>
                              <code>{root.path}</code>
                            </button>
                          </td>
                          <td className="knowledge-bases__date">{formatDate(root.lastUsed)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {selected !== undefined && (
                  <KnowledgeBaseDetails root={selected} onStart={onStart} onStop={onStop} onLogin={onLogin} onLogout={onLogout} />
                )}
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

function KnowledgeBaseDetails({ root, onStart, onStop, onLogin, onLogout }: {
  root: KnowledgeBaseRow;
  onStart: (root: KnowledgeBaseRow) => void;
  onStop: (root: KnowledgeBaseRow) => void;
  onLogin: (root: KnowledgeBaseRow) => void;
  onLogout: (root: KnowledgeBaseRow) => void;
}) {
  const name = root.siteName || root.path.split(/[\\/]/u).filter(Boolean).at(-1) || root.path;
  const metadata = [
    ['Path', root.path],
    ['Identity', root.did],
    ['Last started', formatDate(root.lastStarted)],
    ['Inference config', root.config],
    ['Port block', root.portBlock === undefined ? undefined : String(root.portBlock)],
    ['Gateway', root.gatewayUrl],
  ].filter((item): item is [string, string] => item[1] !== undefined);

  return (
    <aside className="knowledge-bases__detail-panel" aria-label={`${name} details`}>
      <header className="knowledge-bases__detail-head">
        <div>
          <p className="knowledge-bases__eyebrow">Selected Knowledge Base</p>
          <h2>{name}</h2>
        </div>
        <span className={`knowledge-bases__status knowledge-bases__status--${root.status}`}>
          {statusLabel(root.status)}
        </span>
      </header>

      {root.statusDetail !== undefined && <p className="knowledge-bases__status-detail">{root.statusDetail}</p>}

      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-bases-launcher-heading">
        <h3 id="knowledge-bases-launcher-heading">Launcher</h3>
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
        </div>
        {root.operationError !== undefined && <p className="knowledge-bases__action-error">{root.operationError}</p>}
      </section>

      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-bases-session-heading">
        <h3 id="knowledge-bases-session-heading">Desktop session</h3>
        <div className="knowledge-bases__session-control">
          {root.activeSessionUri !== undefined ? (
            <>
              <span className="knowledge-bases__auth knowledge-bases__auth--active">Active</span>
              <button type="button" className="kb__connect kb__connect--on" disabled={root.operation !== undefined} onClick={() => onLogout(root)}>Logout</button>
            </>
          ) : (
            <>
              <span className="knowledge-bases__auth">Not signed in</span>
              <button type="button" className="kb__connect" disabled={root.operation !== undefined || root.gatewayUrl === undefined} onClick={() => onLogin(root)}>
                {root.configuredUri === undefined ? 'Add & Login' : 'Login'}
              </button>
            </>
          )}
        </div>
      </section>

      <dl className="knowledge-bases__metadata">
        {metadata.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function formatDate(value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  return value.slice(0, 10);
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
