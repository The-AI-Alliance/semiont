import { useEffect } from 'react';

export type SecretsCheck =
  | { status: 'checking' }
  | { status: 'found'; path: string }
  | { status: 'missing' }
  | { status: 'unavailable' };

const secretProviders = [
  {
    name: '1Password CLI',
    executable: 'op',
    installUrl: 'https://developer.1password.com/docs/cli/get-started/',
    installLabel: 'Install 1Password CLI',
  },
];

export function SecretsModal({ check, onClose }: { check: SecretsCheck; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal secrets-modal" role="dialog" aria-modal="true" aria-labelledby="secrets-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="secrets-title">Secrets</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Secrets information">
            ×
          </button>
        </header>

        <p className="secrets-modal__intro">Secret providers available to Semiont Desktop.</p>
        {secretProviders.map((provider) => (
          <section className="secrets-modal__provider" key={provider.executable} aria-live="polite">
            <div className="secrets-modal__provider-head">
              <h2>{provider.name}</h2>
              <code>{provider.executable}</code>
            </div>
            {check.status === 'checking' && <p>Checking Desktop’s PATH…</p>}
            {check.status === 'found' && (
              <p className="secrets-modal__available"><strong>Installed.</strong> Found on Desktop’s PATH at <code>{check.path}</code>.</p>
            )}
            {check.status === 'missing' && <p className="secrets-modal__missing">Not found on Desktop’s PATH.</p>}
            {check.status === 'unavailable' && <p>Desktop could not check its PATH.</p>}
            <a href={provider.installUrl} target="_blank" rel="noreferrer">{provider.installLabel}</a>
          </section>
        ))}
      </section>
    </div>
  );
}
