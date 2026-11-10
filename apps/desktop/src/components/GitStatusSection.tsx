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

export function GitStatusSection({ check }: { check: GitCheck }) {
  return (
    <section className="service-group__git" aria-labelledby="record-git-title">
      <h2 id="record-git-title">Git</h2>
      <section className="git-modal__check" aria-live="polite">
        {check.status === 'checking' && <p>Checking Desktop’s PATH…</p>}
        {check.status === 'found' && (
          <>
            <strong className="git-modal__available">Git was found on Desktop’s PATH.</strong>
            <code>{check.path}</code>
          </>
        )}
        {check.status === 'missing' && <strong className="git-modal__missing">Git was not found on Desktop’s PATH.</strong>}
        {check.status === 'unavailable' && <p>Desktop could not check its PATH for Git.</p>}
      </section>
      <section className="runtime-modal__section" aria-labelledby="git-install-title">
        <h3 id="git-install-title">Install Git</h3>
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
  );
}
