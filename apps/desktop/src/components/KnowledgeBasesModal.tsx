import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ControlProgress, ControlRoot, ControlRootsInitParams, ControlServiceStatus } from '../../electron/control-types.gen';
import { controlFailureText } from '../lib/launcher-bridge';
import { localRootTabId } from './WorkspaceTabs';

export type KnowledgeBaseRuntimeStatus = 'checking' | 'starting' | 'running' | 'stopped' | 'attention' | 'unknown';

/** A local root, as roots.list reports it, with what Desktop has learned of its stack. */
export interface KnowledgeBaseRow extends ControlRoot {
  path: string;
  status: KnowledgeBaseRuntimeStatus;
  statusDetail?: string;
  services?: ControlServiceStatus[];
  gatewayUrl?: string;
  configuredUri?: string;
  desktopAlias?: string;
  gitBranch?: string;
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
  onCreate,
  focusSearchOnOpen,
  openTabUris,
  activeTabUri,
  initialSelectedPath,
  onOpenTab,
  onClose,
}: {
  state: KnowledgeBasesState;
  onRefresh: () => void;
  onCreate: (options: NewKnowledgeBaseOptions, onProgress: (progress: ControlProgress) => void) => Promise<string>;
  focusSearchOnOpen: boolean;
  openTabUris: string[];
  activeTabUri: string | null;
  initialSelectedPath: string | null;
  onOpenTab: (root: KnowledgeBaseRow) => void;
  onClose: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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
    if (state.status !== 'result') return;
    if (initialSelectedPath !== null && filteredRoots.some((root) => root.path === initialSelectedPath)) {
      setSelectedPath(initialSelectedPath);
      return;
    }
    setSelectedPath((current) => current !== null && filteredRoots.some((root) => root.path === current)
      ? current
      : filteredRoots[0]?.path ?? null);
  }, [filteredRoots, initialSelectedPath, state.status]);
  const selected = filteredRoots.find((root) => root.path === selectedPath) ?? filteredRoots[0];
  const selectedTabUri = selected?.configuredUri ?? selected?.gatewayUrl;
  const selectedIsOpen = selected !== undefined && (
    openTabUris.includes(localRootTabId(selected.path)) ||
    (selectedTabUri !== undefined && openTabUris.includes(selectedTabUri))
  );
  const selectedIsActive = selected !== undefined && (
    selectedTabUri === undefined
      ? localRootTabId(selected.path) === activeTabUri
      : selectedTabUri === activeTabUri
  );
  useEffect(() => {
    if (focusSearchOnOpen && state.status === 'result') searchRef.current?.focus();
  }, [focusSearchOnOpen, state.status]);

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal config--knowledge-bases" role="dialog" aria-modal="true" aria-labelledby="knowledge-bases-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="knowledge-bases-title">Knowledge Bases</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Knowledge Bases">×</button>
        </header>
        <p className="knowledge-bases__intro">Choose a local knowledge base to open as a workspace tab. You can open it before the launcher is running.</p>
        {state.status === 'loading' ? (
          <p className="knowledge-bases__empty">Asking the launcher for its knowledge bases…</p>
        ) : state.status === 'failed' ? (
          <pre className="knowledge-bases__error">Could not list the knowledge bases: {state.message}</pre>
        ) : (
          <>
            {state.result.warnings?.map((warning) => (
              <p className="knowledge-bases__source" key={warning}>{warning}</p>
            ))}
            <label className="knowledge-bases__filter">
              <input
                ref={searchRef}
                type="search"
                value={filterText}
                onChange={(event) => setFilterText(event.target.value)}
                placeholder="Filter by name or path"
                aria-label="Filter knowledge bases by name or path"
              />
              <span aria-live="polite">{filteredRoots.length} of {roots.length}</span>
            </label>
            {roots.length === 0 ? (
              <p className="knowledge-bases__empty">No local knowledge bases are recorded yet. Create one with New.</p>
            ) : filteredRoots.length === 0 ? (
              <p className="knowledge-bases__empty">No knowledge bases match “{filterText.trim()}”.</p>
            ) : (
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
                                  <strong>{root.desktopAlias || root.siteName || root.path.split(/[\\/]/u).filter(Boolean).at(-1) || root.path}</strong>
                                  <code>{root.path}</code>
                                </button>
                              </td>
                              <td className="knowledge-bases__date">{formatDate(root.lastUsed)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                  </div>
                )}
          </>
        )}
        <footer className="knowledge-bases__footer">
          <button type="button" className="kb__connect" onClick={() => setShowCreate(true)}>New</button>
          <div className="knowledge-bases__footer-actions">
            {selected !== undefined && (
              <button type="button" className="kb__connect" disabled={selectedIsActive} onClick={() => onOpenTab(selected)}>
                {selectedIsActive ? 'Current tab' : selectedIsOpen ? 'Switch to tab' : 'Open as tab'}
              </button>
            )}
            <button type="button" className="kb__connect" onClick={onRefresh}>Refresh</button>
          </div>
        </footer>
      </section>
      {showCreate && (
        <NewKnowledgeBaseModal
          onCreate={onCreate}
          onClose={() => setShowCreate(false)}
          onCreated={(path) => {
            setShowCreate(false);
            setFilterText('');
            setSelectedPath(path);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

export function KnowledgeBaseModal({
  root,
  kb,
  connected,
  onLogin,
  onLogout,
  onForget,
  onRenameAlias,
  onClose,
}: {
  root: KnowledgeBaseRow | null;
  kb: { uri: string; alias?: string } | null;
  connected: boolean;
  onLogin: (root: KnowledgeBaseRow) => void;
  onLogout: (root: KnowledgeBaseRow) => void;
  onForget: (root: KnowledgeBaseRow) => void;
  onRenameAlias: (root: KnowledgeBaseRow, alias: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const name = root?.desktopAlias || root?.siteName || kb?.alias || root?.path.split(/[\\/]/u).filter(Boolean).at(-1) || kb?.uri || 'Knowledge Base';
  return (
    <div className="modal modal--kb-details" onClick={onClose}>
      <section className="config config--modal config--knowledge-bases knowledge-bases__manage-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-base-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="knowledge-base-title">Knowledge Base</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Knowledge Base">×</button>
        </header>
        {root !== null ? (
          <KnowledgeBaseDetails
            root={root}
            onLogin={onLogin}
            onLogout={onLogout}
            onForget={onForget}
            onRenameAlias={onRenameAlias}
          />
        ) : kb !== null ? (
          <div className="knowledge-bases__remote-details">
            <header className="knowledge-bases__detail-head">
              <div>
                <p className="knowledge-bases__eyebrow">Selected Knowledge Base</p>
                <h2>{name}</h2>
              </div>
              <span className={`knowledge-bases__status knowledge-bases__status--${connected ? 'running' : 'stopped'}`}>{connected ? 'Connected' : 'Not connected'}</span>
            </header>
            <dl className="knowledge-bases__metadata"><div><dt>Gateway</dt><dd>{kb.uri}</dd></div></dl>
            <p className="knowledge-bases__action-note">Launcher controls and logs are in Services for knowledge bases registered as local roots.</p>
          </div>
        ) : (
          <p className="knowledge-bases__empty">No knowledge base is selected.</p>
        )}
      </section>
    </div>
  );
}

function NewKnowledgeBaseModal({ onCreate, onClose, onCreated }: {
  onCreate: (options: NewKnowledgeBaseOptions, onProgress: (progress: ControlProgress) => void) => Promise<string>;
  onClose: () => void;
  onCreated: (path: string) => void;
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
      const createdPath = await onCreate(options, (notice) => setProgress((current) => [...current, notice].slice(-80)));
      onCreated(createdPath);
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

function KnowledgeBaseDetails({ root, onLogin, onLogout, onForget, onRenameAlias }: {
  root: KnowledgeBaseRow;
  onLogin: (root: KnowledgeBaseRow) => void;
  onLogout: (root: KnowledgeBaseRow) => void;
  onForget: (root: KnowledgeBaseRow) => void;
  onRenameAlias: (root: KnowledgeBaseRow, alias: string) => void;
}) {
  const [confirmForget, setConfirmForget] = useState(false);
  const [aliasDraft, setAliasDraft] = useState(root.desktopAlias ?? '');
  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [generatePassword, setGeneratePassword] = useState(true);
  const [addingUser, setAddingUser] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [userResult, setUserResult] = useState<{ email: string; identity: string; generatedPassword?: string } | null>(null);
  useEffect(() => {
    setConfirmForget(false);
    setAliasDraft(root.desktopAlias ?? '');
    setUserEmail('');
    setUserPassword('');
    setUserError(null);
    setUserResult(null);
  }, [root.desktopAlias, root.path]);
  const name = root.siteName || root.path.split(/[\\/]/u).filter(Boolean).at(-1) || root.path;
  const metadata = [
    ['Path', root.path],
    ['Identity', root.did],
    ['Git branch', root.gitBranch],
    ['Inference config', root.config],
    ['Gateway', root.gatewayUrl],
  ].filter((item): item is [string, string] => item[1] !== undefined);

  return (
    <div className="knowledge-bases__detail-panel" aria-label={`${name} details`}>
      <div className="knowledge-bases__detail-summary">
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

        <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-bases-display-name-heading">
          <h3 id="knowledge-bases-display-name-heading">Desktop display name</h3>
          <form className="knowledge-bases__alias-form" onSubmit={(event) => {
            event.preventDefault();
            onRenameAlias(root, aliasDraft.trim());
          }}>
            <input
              aria-label="Desktop display name"
              value={aliasDraft}
              onChange={(event) => setAliasDraft(event.target.value)}
              placeholder={root.siteName || root.path.split(/[\\/]/u).filter(Boolean).at(-1) || root.path}
            />
            <button type="submit" className="kb__connect">Save name</button>
          </form>
        </section>
      </div>

      <div className="knowledge-bases__detail-grid">
        <div className="knowledge-bases__operations">
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

      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-bases-useradd-heading">
        <h3 id="knowledge-bases-useradd-heading">Users</h3>
        <p className="knowledge-bases__action-note">Add an account to this knowledge base’s launcher-managed identity realm. The user completes their profile at first sign-in.</p>
        <form className="knowledge-bases__useradd-form" onSubmit={(event) => {
          event.preventDefault();
          const bridge = window.launcherBridge;
          if (bridge === undefined || addingUser) return;
          setAddingUser(true);
          setUserError(null);
          setUserResult(null);
          const params = generatePassword
            ? { target: { kind: 'local' as const, root: root.path }, email: userEmail.trim(), generatePassword: true }
            : { target: { kind: 'local' as const, root: root.path }, email: userEmail.trim(), password: userPassword, generatePassword: false };
          void bridge.startControl('identity.useradd', params, (event) => {
            if (event.kind !== 'answer') return;
            setAddingUser(false);
            setUserPassword('');
            if (!event.outcome.ok) {
              setUserError(controlFailureText(event.outcome.error));
              return;
            }
            setUserResult(event.outcome.result);
            setUserEmail('');
          }).catch((error: unknown) => {
            setAddingUser(false);
            setUserPassword('');
            setUserError(error instanceof Error ? error.message : String(error));
          });
        }}>
          <label className="knowledge-bases__field">
            <span>Email</span>
            <input type="email" autoComplete="email" required value={userEmail} onChange={(event) => setUserEmail(event.target.value)} placeholder="person@example.com" />
          </label>
          <label className="knowledge-bases__useradd-mode">
            <input type="checkbox" checked={generatePassword} onChange={(event) => setGeneratePassword(event.target.checked)} />
            Generate a one-time password
          </label>
          {!generatePassword && <label className="knowledge-bases__field">
            <span>Password</span>
            <input type="password" autoComplete="new-password" required minLength={1} value={userPassword} onChange={(event) => setUserPassword(event.target.value)} />
          </label>}
          <button type="submit" className="kb__connect" disabled={addingUser || root.status === 'stopped' || root.operation !== undefined || userEmail.trim() === '' || (!generatePassword && userPassword === '')}>
            {addingUser ? 'Adding user…' : 'Add user'}
          </button>
        </form>
        {root.status === 'stopped' && <p className="knowledge-bases__action-note">Start this knowledge base before adding an account.</p>}
        {userError !== null && <p className="knowledge-bases__action-error" role="alert">{userError}</p>}
        {userResult !== null && <div className="knowledge-bases__useradd-result" role="status">
          <p>Created account for <strong>{userResult.email}</strong>.</p>
          <p><span>Identity</span> <code>{userResult.identity}</code></p>
          {userResult.generatedPassword !== undefined && <p className="knowledge-bases__generated-password"><span>Generated password (shown once)</span><code>{userResult.generatedPassword}</code></p>}
          {userResult.generatedPassword !== undefined && <button type="button" className="kb__connect" onClick={() => {
            void navigator.clipboard.writeText(userResult.generatedPassword!).catch(() => {
              setUserError('Could not copy the generated password. Select it above and copy it manually.');
            });
          }}>Copy generated password</button>}
        </div>}
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
        </div>
      </div>
    </div>
  );
}

function formatDate(value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  return value.slice(0, 10);
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
