import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ControlProgress, ControlRoot, ControlRootsInitParams, ControlServiceStatus } from '../../electron/control-types.gen';

export type KnowledgeBaseRuntimeStatus = 'checking' | 'starting' | 'running' | 'stopped' | 'attention' | 'unknown';

/** A local root, as roots.list reports it, with what Desktop has learned of its stack. */
export interface KnowledgeBaseRow extends ControlRoot {
  path: string;
  status: KnowledgeBaseRuntimeStatus;
  statusDetail?: string;
  services?: ControlServiceStatus[];
  gatewayUrl?: string;
  configuredUri?: string;
  activeSessionUri?: string;
  operation?: 'starting' | 'stopping' | 'forgetting';
  operationStartedAt?: number;
  operationError?: string;
  operationErrorAction?: 'launcher' | 'forget';
  operationProgress?: ControlProgress[];
}

export type KnowledgeBasesState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'result'; result: { roots: KnowledgeBaseRow[]; warnings?: string[] } };

export type NewKnowledgeBaseOptions = Omit<ControlRootsInitParams, 'apiVersion'>;

export function KnowledgeBasesModal({
  state,
  onRefresh,
  onStart,
  onStop,
  onLogin,
  onLogout,
  onForget,
  onFollowLogs,
  onCreate,
  onClose,
}: {
  state: KnowledgeBasesState;
  onRefresh: () => void;
  onStart: (root: KnowledgeBaseRow) => void;
  onStop: (root: KnowledgeBaseRow) => void;
  onLogin: (root: KnowledgeBaseRow) => void;
  onLogout: (root: KnowledgeBaseRow) => void;
  onForget: (root: KnowledgeBaseRow) => void;
  onFollowLogs: (root: KnowledgeBaseRow) => void;
  onCreate: (options: NewKnowledgeBaseOptions, onProgress: (progress: ControlProgress) => void) => Promise<void>;
  onClose: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showCreate) setShowCreate(false);
        else onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, showCreate]);

  const roots = state.status === 'result' ? state.result.roots : [];
  const normalizedFilter = filterText.trim().toLocaleLowerCase();
  const filteredRoots = useMemo(() => normalizedFilter === '' ? roots : roots.filter((root) => {
    const name = root.siteName || root.path.split(/[\\/]/u).filter(Boolean).at(-1) || root.path;
    return name.toLocaleLowerCase().includes(normalizedFilter) || root.path.toLocaleLowerCase().includes(normalizedFilter);
  }), [normalizedFilter, roots]);
  useEffect(() => {
    setSelectedPath((current) => current !== null && filteredRoots.some((root) => root.path === current)
      ? current
      : filteredRoots[0]?.path ?? null);
  }, [filteredRoots]);
  const selected = filteredRoots.find((root) => root.path === selectedPath) ?? filteredRoots[0];

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal config--knowledge-bases" role="dialog" aria-modal="true" aria-labelledby="knowledge-bases-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="knowledge-bases-title">Knowledge Bases</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Knowledge Bases">×</button>
        </header>
        <p className="knowledge-bases__intro">Choose a local root to see its launcher state, Desktop session, and controls. Starting uses the root’s saved launcher settings.</p>
        {state.status === 'loading' ? (
          <p className="knowledge-bases__empty">Asking the launcher for its knowledge bases…</p>
        ) : state.status === 'failed' ? (
          <pre className="knowledge-bases__error">Could not list the knowledge bases: {state.message}</pre>
        ) : (
          <>
            {state.result.warnings?.map((warning) => (
              <p className="knowledge-bases__source" key={warning}>{warning}</p>
            ))}
            {roots.length === 0 ? (
              <p className="knowledge-bases__empty">No local knowledge bases are recorded yet.</p>
            ) : (
              <>
                <label className="knowledge-bases__filter">
                  <input
                    type="search"
                    value={filterText}
                    onChange={(event) => setFilterText(event.target.value)}
                    placeholder="Filter by name or path"
                    aria-label="Filter knowledge bases by name or path"
                  />
                  <span aria-live="polite">{filteredRoots.length} of {roots.length}</span>
                </label>
                {filteredRoots.length === 0 ? (
                  <p className="knowledge-bases__empty">No knowledge bases match “{filterText.trim()}”.</p>
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
                          {filteredRoots.map((root) => (
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
                      <KnowledgeBaseDetails
                        root={selected}
                        onStart={onStart}
                        onStop={onStop}
                        onLogin={onLogin}
                        onLogout={onLogout}
                        onForget={onForget}
                        onFollowLogs={onFollowLogs}
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
        <footer className="knowledge-bases__footer">
          <button type="button" className="kb__connect" onClick={() => setShowCreate(true)}>New</button>
          <button type="button" className="kb__connect" onClick={onRefresh}>Refresh</button>
        </footer>
      </section>
      {showCreate && (
        <NewKnowledgeBaseModal
          onCreate={onCreate}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            setFilterText('');
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

function NewKnowledgeBaseModal({ onCreate, onClose, onCreated }: {
  onCreate: (options: NewKnowledgeBaseOptions, onProgress: (progress: ControlProgress) => void) => Promise<void>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [siteName, setSiteName] = useState('');
  const [domain, setDomain] = useState('');
  const [inference, setInference] = useState<'ollama' | 'anthropic'>('ollama');
  const [model, setModel] = useState('');
  const [embedding, setEmbedding] = useState('nomic-embed-text');
  const [modelLight, setModelLight] = useState('');
  const [configName, setConfigName] = useState('');
  const [anthropicEndpoint, setAnthropicEndpoint] = useState('');
  const [ollamaBase, setOllamaBase] = useState('');
  const [ollamaRegistry, setOllamaRegistry] = useState('');
  const [progress, setProgress] = useState<ControlProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const chooseDirectory = async () => {
    try {
      const chosen = await window.launcherBridge?.chooseDirectory();
      if (chosen !== null && chosen !== undefined) setPath(chosen);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    setProgress([]);
    const options: NewKnowledgeBaseOptions = {
      path: path.trim(),
      domain: domain.trim(),
      inference,
      ...(name.trim() === '' ? {} : { name: name.trim() }),
      ...(siteName.trim() === '' ? {} : { siteName: siteName.trim() }),
      ...(model.trim() === '' ? {} : { model: model.trim() }),
      ...(embedding.trim() === '' ? {} : { embedding: embedding.trim() }),
      ...(modelLight.trim() === '' ? {} : { modelLight: modelLight.trim() }),
      ...(configName.trim() === '' ? {} : { configName: configName.trim() }),
      ...(anthropicEndpoint.trim() === '' ? {} : { anthropicEndpoint: anthropicEndpoint.trim() }),
      ...(ollamaBase.trim() === '' ? {} : { ollamaBase: ollamaBase.trim() }),
      ...(ollamaRegistry.trim() === '' ? {} : { ollamaRegistry: ollamaRegistry.trim() }),
    };
    try {
      await onCreate(options, (notice) => setProgress((current) => [...current, notice].slice(-80)));
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  };

  return (
    <div
      className="modal modal--nested"
      onClick={(event) => { event.stopPropagation(); if (!creating) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!creating) onClose();
        }
      }}
    >
      <section className="config config--modal knowledge-bases__create" role="dialog" aria-modal="true" aria-labelledby="new-kb-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="new-kb-title">New Knowledge Base</h1>
          <button type="button" className="config__close" disabled={creating} onClick={onClose} aria-label="Close New Knowledge Base">×</button>
        </header>
        <p className="knowledge-bases__intro">Create an empty local KB. It will add Semiont configuration files and initialize Git in the selected folder.</p>
        <form className="knowledge-bases__create-form" onSubmit={(event) => void create(event)}>
          <label className="knowledge-bases__field knowledge-bases__field--path">
            <span>Folder</span>
            <div>
              <input required value={path} onChange={(event) => setPath(event.target.value)} placeholder="Choose an existing empty folder" />
              <button type="button" className="kb__connect" disabled={creating} onClick={() => void chooseDirectory()}>Browse…</button>
            </div>
          </label>
          <div className="knowledge-bases__field-grid">
            <label className="knowledge-bases__field"><span>Project name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Defaults to folder name" /></label>
            <label className="knowledge-bases__field"><span>Site name</span><input value={siteName} onChange={(event) => setSiteName(event.target.value)} placeholder="Defaults to project name" /></label>
          </div>
          <label className="knowledge-bases__field">
            <span>Permanent did:web domain</span>
            <input required value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="owner.github.io:repository" />
            <small>This identity is written into the KB and should not change later.</small>
          </label>
          <div className="knowledge-bases__field-grid">
          <label className="knowledge-bases__field"><span>Inference provider</span><select value={inference} onChange={(event) => setInference(event.target.value as 'ollama' | 'anthropic')}><option value="ollama">Ollama</option><option value="anthropic">Anthropic</option></select><small>Anthropic credentials come from the launcher’s configured secret source.</small></label>
            <label className="knowledge-bases__field"><span>Primary model</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder={inference === 'ollama' ? 'Defaults to gemma3:270m' : 'Defaults to recommended Anthropic model'} /></label>
          </div>
          <label className="knowledge-bases__field"><span>Embedding model (Ollama)</span><input value={embedding} onChange={(event) => setEmbedding(event.target.value)} placeholder="nomic-embed-text" /></label>
          <details className="knowledge-bases__advanced">
            <summary>More configuration</summary>
            <div className="knowledge-bases__create-advanced">
              <label className="knowledge-bases__field"><span>Light model example</span><input value={modelLight} onChange={(event) => setModelLight(event.target.value)} placeholder="Optional" /></label>
              <label className="knowledge-bases__field"><span>Inference config name</span><input value={configName} onChange={(event) => setConfigName(event.target.value)} placeholder="Defaults to provider" /></label>
              <label className="knowledge-bases__field"><span>Anthropic endpoint</span><input value={anthropicEndpoint} onChange={(event) => setAnthropicEndpoint(event.target.value)} placeholder="https://api.anthropic.com" /></label>
              <label className="knowledge-bases__field"><span>Ollama endpoint</span><input value={ollamaBase} onChange={(event) => setOllamaBase(event.target.value)} placeholder="http://localhost:11434" /></label>
              <label className="knowledge-bases__field"><span>Ollama registry</span><input value={ollamaRegistry} onChange={(event) => setOllamaRegistry(event.target.value)} placeholder="https://registry.ollama.ai" /></label>
            </div>
          </details>
          {progress.length > 0 && <ol className="knowledge-bases__create-progress" aria-label="Creation progress" aria-live="polite">{progress.map((line, index) => <li key={`${line.requestId}-${index}`}>{line.text}</li>)}</ol>}
          {error !== null && <p className="knowledge-bases__action-error">{error}</p>}
          <footer className="knowledge-bases__create-footer">
            <button type="button" className="kb__connect" disabled={creating} onClick={onClose}>Cancel</button>
            <button type="submit" className="kb__connect" disabled={creating}>{creating ? 'Creating…' : 'Create Knowledge Base'}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function KnowledgeBaseDetails({ root, onStart, onStop, onLogin, onLogout, onForget, onFollowLogs }: {
  root: KnowledgeBaseRow;
  onStart: (root: KnowledgeBaseRow) => void;
  onStop: (root: KnowledgeBaseRow) => void;
  onLogin: (root: KnowledgeBaseRow) => void;
  onLogout: (root: KnowledgeBaseRow) => void;
  onForget: (root: KnowledgeBaseRow) => void;
  onFollowLogs: (root: KnowledgeBaseRow) => void;
}) {
  const [confirmForget, setConfirmForget] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => setConfirmForget(false), [root.path]);
  useEffect(() => {
    if (root.operationStartedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [root.operationStartedAt]);

  const name = root.siteName || root.path.split(/[\\/]/u).filter(Boolean).at(-1) || root.path;
  const metadata = [
    ['Path', root.path],
    ['Identity', root.did],
    ['Inference config', root.config],
    ['Gateway', root.gatewayUrl],
  ].filter((item): item is [string, string] => item[1] !== undefined);

  return (
    <aside className="knowledge-bases__detail-panel" aria-label={`${name} details`}>
      <header className="knowledge-bases__detail-head">
        <div>
          <p className="knowledge-bases__eyebrow">Selected Knowledge Base</p>
          <h2>{name}</h2>
        </div>
        <span className={`knowledge-bases__status knowledge-bases__status--${root.operation === 'starting' ? 'starting' : root.status}`}>
          {root.operation === 'starting' ? 'Starting…' : root.operation === 'stopping' ? 'Stopping…' : statusLabel(root.status)}
        </span>
      </header>

      {root.statusDetail !== undefined && <p className="knowledge-bases__status-detail">{root.statusDetail}</p>}

      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-bases-services-heading">
        <h3 id="knowledge-bases-services-heading">Services</h3>
        {root.services === undefined ? (
          <p className="knowledge-bases__action-note">{root.status === 'checking' ? 'Checking service status…' : 'Service status is unavailable.'}</p>
        ) : root.services.length === 0 ? (
          <p className="knowledge-bases__action-note">{root.status === 'unknown' ? 'Service status is unavailable.' : 'No service details reported.'}</p>
        ) : <ServiceGroups services={root.services} />}
      </section>

      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-bases-launcher-heading">
        <h3 id="knowledge-bases-launcher-heading">Launcher</h3>
        <div className="knowledge-bases__controls">
          {root.operation === 'starting' ? (
            <button type="button" className="kb__connect" disabled>Starting…</button>
          ) : root.operation === 'stopping' ? (
            <button type="button" className="kb__connect kb__connect--on" disabled>Stopping…</button>
          ) : root.status === 'running' ? (
            <button type="button" className="kb__connect kb__connect--on" disabled={root.operation !== undefined} onClick={() => onStop(root)}>
              Stop
            </button>
          ) : root.status === 'stopped' ? (
            <button type="button" className="kb__connect" disabled={root.operation !== undefined} onClick={() => onStart(root)}>
              Start
            </button>
          ) : (
            <>
              <button type="button" className="kb__connect" disabled={root.operation !== undefined} onClick={() => onStart(root)}>
                Start / repair
              </button>
              <button type="button" className="kb__connect kb__connect--on" disabled={root.operation !== undefined} onClick={() => onStop(root)}>
                Stop
              </button>
            </>
          )}
        </div>
        {root.operationError !== undefined && root.operationErrorAction === 'launcher' && <p className="knowledge-bases__action-error">{root.operationError}</p>}
        {root.operation !== undefined && (
          <div className="knowledge-bases__progress" role="status" aria-live="polite">
            <p>{root.operation === 'starting' ? 'Start progress' : root.operation === 'stopping' ? 'Stop progress' : 'Operation progress'} · {formatElapsed(root.operationStartedAt, now)}</p>
            {root.operationProgress === undefined || root.operationProgress.length === 0 ? (
              <span className="knowledge-bases__progress-waiting">Checking service status; waiting for launcher progress…</span>
            ) : (
              <ol>
                {root.operationProgress.slice(-5).map((progress, index) => (
                  <li key={`${progress.requestId}-${index}`} className={`knowledge-bases__progress--${progress.kind}`}>
                    {progress.kind === 'command' ? <code>{progress.text}</code> : progress.text}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {root.operation === undefined && root.operationProgress !== undefined && root.operationError !== undefined && (
          <div className="knowledge-bases__progress" aria-label="Progress before failure">
            <p>Last progress before failure</p>
            <ol>
              {root.operationProgress.map((progress, index) => (
                <li key={`${progress.requestId}-${index}`} className={`knowledge-bases__progress--${progress.kind}`}>
                  {progress.kind === 'command' ? <code>{progress.text}</code> : progress.text}
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-bases-logs-heading">
        <h3 id="knowledge-bases-logs-heading">Logs</h3>
        <div className="knowledge-bases__controls">
          <button
            type="button"
            className="kb__connect"
            disabled={root.operation !== undefined || (root.status !== 'running' && root.status !== 'attention')}
            onClick={() => onFollowLogs(root)}
          >
            Follow logs
          </button>
        </div>
        {root.status !== 'running' && root.status !== 'attention' && (
          <p className="knowledge-bases__action-note">Start this knowledge base to follow its service logs.</p>
        )}
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

      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-bases-registry-heading">
        <h3 id="knowledge-bases-registry-heading">Registry</h3>
        {!confirmForget ? (
          <button
            type="button"
            className="kb__connect kb__connect--danger"
            disabled={root.operation !== undefined || root.status !== 'stopped'}
            onClick={() => setConfirmForget(true)}
          >
            {root.operation === 'forgetting' ? 'Forgetting…' : 'Forget…'}
          </button>
        ) : (
          <div className="knowledge-bases__forget-confirm" role="group" aria-label="Confirm forgetting knowledge base">
            <p>This removes the launcher registry entry only. It does not delete the knowledge base files or persistent stack data. Stop the stack first.</p>
            <div className="knowledge-bases__controls">
              <button type="button" className="kb__connect" onClick={() => setConfirmForget(false)}>Keep</button>
              <button type="button" className="kb__connect kb__connect--danger" disabled={root.operation !== undefined} onClick={() => onForget(root)}>
                {root.operation === 'forgetting' ? 'Forgetting…' : 'Forget from launcher'}
              </button>
            </div>
          </div>
        )}
        {root.operationError !== undefined && root.operationErrorAction === 'forget' && (
          <p className="knowledge-bases__action-error">{root.operationError}</p>
        )}
      </section>
    </aside>
  );
}

function formatDate(value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  return value.slice(0, 10);
}

function formatElapsed(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return 'in progress';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s elapsed` : `${minutes}m ${seconds % 60}s elapsed`;
}

const SERVICE_GROUPS = [
  ['record', 'Record'],
  ['index', 'Index'],
  ['issuer', 'Issuer'],
  ['knowledge-workers', 'Knowledge workers'],
  ['providers', 'Providers'],
  ['telemetry', 'Telemetry'],
] as const;

function ServiceGroups({ services }: { services: ControlServiceStatus[] }) {
  if (services.length === 0) return <p className="knowledge-bases__action-note">No service details reported.</p>;
  return (
    <div className="knowledge-bases__service-groups">
      {SERVICE_GROUPS.map(([group, label]) => {
        const members = services.filter((service) => service.group === group);
        if (members.length === 0) return null;
        return (
          <section className="knowledge-bases__service-group" key={group} aria-label={`${label} services`}>
            <h4>{label}</h4>
            <ul>
              {members.map((service) => (
                <li key={`${service.role}/${service.product ?? ''}`}>
                  <span className="knowledge-bases__service-name">
                    <strong>{service.role}</strong>
                    {service.product !== undefined && <small>{service.product}</small>}
                  </span>
                  <span className={`knowledge-bases__service-state knowledge-bases__service-state--${serviceStateTone(service)}`}>
                    {serviceStateLabel(service)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function serviceStateLabel(service: ControlServiceStatus): string {
  switch (service.state) {
    case 'running': return service.healthy ? 'Running · healthy' : 'Running · unhealthy';
    case 'reachable': return service.healthy ? 'Reachable' : 'Reachable · unhealthy';
    case 'stopped': return 'Stopped';
    case 'unreachable': return 'Unreachable';
    case 'absent': return 'Absent';
    case 'not-configured': return 'Not configured';
  }
}

function serviceStateTone(service: ControlServiceStatus): 'healthy' | 'unhealthy' | 'neutral' {
  if (service.state === 'not-configured' || service.state === 'absent' || service.state === 'stopped') return 'neutral';
  return service.healthy ? 'healthy' : 'unhealthy';
}

function statusLabel(status: KnowledgeBaseRuntimeStatus): string {
  switch (status) {
    case 'checking': return 'Checking…';
    case 'starting': return 'Starting…';
    case 'running': return 'Running';
    case 'stopped': return 'Stopped';
    case 'attention': return 'Needs attention';
    case 'unknown': return 'Status unavailable';
  }
}
