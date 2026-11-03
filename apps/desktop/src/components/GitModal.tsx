import { useEffect } from 'react';

export type GitCheck =
  | { status: 'checking' }
  | { status: 'found'; path: string }
  | { status: 'missing' }
  | { status: 'unavailable' };

const installOptions = [
  {
    label: 'Git for macOS',
    detail: 'Official installation options',
    url: 'https://git-scm.com/install/mac',
  },
  {
    label: 'Apple Command Line Tools',
    detail: 'Includes Git; install with xcode-select --install',
    url: 'https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/',
  },
];

export function GitModal({ check, onClose }: { check: GitCheck; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal git-modal" role="dialog" aria-modal="true" aria-labelledby="git-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="git-title">Git</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Git information">
            ×
          </button>
        </header>

        <section className="git-modal__check" aria-live="polite">
          {check.status === 'checking' && <p>Checking Desktop’s PATH…</p>}
          {check.status === 'found' && (
            <>
              <strong className="git-modal__available">Git was found on Desktop’s PATH.</strong>
              <code>{check.path}</code>
            </>
          )}
          {check.status === 'missing' && (
            <strong className="git-modal__missing">Git was not found on Desktop’s PATH.</strong>
          )}
          {check.status === 'unavailable' && <p>Desktop could not check its PATH for Git.</p>}
        </section>

        <section className="runtime-modal__section" aria-labelledby="git-install-title">
          <h2 id="git-install-title">Install Git</h2>
          <ul className="runtime-modal__install-list">
            {installOptions.map((option) => (
              <li key={option.label}>
                <a href={option.url} target="_blank" rel="noreferrer">
                  <span>{option.label}</span>
                  <small>{option.detail}</small>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </section>
    </div>
  );
}
