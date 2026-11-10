import { useEffect, useState } from 'react';
import { controlFailureText } from '../lib/launcher-bridge';
import type { KnowledgeBaseRow } from './KnowledgeBasesModal';

export function KnowledgeBaseUsersModal({ root, kb, onClose }: {
  root: KnowledgeBaseRow | null;
  kb: { uri: string; alias?: string } | null;
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
      <section className="config config--modal config--knowledge-bases knowledge-bases__manage-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-base-users-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="knowledge-base-users-title">Users</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Users">×</button>
        </header>
        {root !== null ? (
          <KnowledgeBaseUsersDetails root={root} name={name} />
        ) : kb !== null ? (
          <div className="knowledge-bases__remote-details">
            <header className="knowledge-bases__detail-head">
              <div>
                <p className="knowledge-bases__eyebrow">Selected Knowledge Base</p>
                <h2>{name}</h2>
              </div>
            </header>
            <p className="knowledge-bases__action-note">User administration is available here for local knowledge bases whose identity realm is managed by the launcher. Manage accounts for this remote knowledge base at its identity provider.</p>
          </div>
        ) : (
          <p className="knowledge-bases__empty">No knowledge base is selected.</p>
        )}
      </section>
    </div>
  );
}

function KnowledgeBaseUsersDetails({ root, name }: { root: KnowledgeBaseRow; name: string }) {
  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [generatePassword, setGeneratePassword] = useState(true);
  const [addingUser, setAddingUser] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [userResult, setUserResult] = useState<{ email: string; identity: string; generatedPassword?: string } | null>(null);

  return (
    <div className="knowledge-bases__detail-panel" aria-label={`${name} users`}>
      <header className="knowledge-bases__detail-head">
        <div>
          <p className="knowledge-bases__eyebrow">Selected Knowledge Base</p>
          <h2>{name}</h2>
        </div>
        <span className={`knowledge-bases__status knowledge-bases__status--${root.operation === 'starting' ? 'starting' : root.status}`}>
          {root.operation === 'starting' ? 'Starting…' : root.operation === 'stopping' ? 'Stopping…' : statusLabel(root.status)}
        </span>
      </header>
      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-bases-useradd-heading">
        <h3 id="knowledge-bases-useradd-heading">Add user</h3>
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
    </div>
  );
}

function statusLabel(status: KnowledgeBaseRow['status']): string {
  switch (status) {
    case 'checking': return 'Checking…';
    case 'starting': return 'Starting…';
    case 'running': return 'Running';
    case 'stopped': return 'Stopped';
    case 'attention': return 'Needs attention';
    case 'unknown': return 'Status unavailable';
  }
}
