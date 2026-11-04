import { useEffect } from 'react';

const PROJECT = [
  ['Website', 'https://the-ai-alliance.github.io/semiont/'],
  ['Source', 'https://github.com/The-AI-Alliance/semiont'],
  ['Issues', 'https://github.com/The-AI-Alliance/semiont/issues'],
] as const;

export function AboutModal({
  version,
  commit,
  buildDate,
  onClose,
}: {
  version: string;
  commit: string;
  buildDate: string;
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
      <section
        className="config config--modal about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="config__head">
          <h1 id="about-title">About Semiont</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close About">
            ×
          </button>
        </header>

        <p className="about-modal__org">The AI Alliance</p>
        <p className="about-modal__description">
          An open, source-grounded semantic knowledge platform — a shared workspace where humans and AI agents
          annotate, connect, enrich, and govern domain knowledge for accurate applications, agents, and workflows.
        </p>

        <dl className="about-modal__details">
          <div><dt>Version</dt><dd>{version} (commit {commit}, built {buildDate})</dd></div>
          {PROJECT.map(([label, href]) => (
            <div key={label}><dt>{label}</dt><dd><a href={href} target="_blank" rel="noreferrer">{href}</a></dd></div>
          ))}
          <div><dt>Images</dt><dd>ghcr.io/the-ai-alliance</dd></div>
          <div><dt>License</dt><dd>Apache-2.0</dd></div>
        </dl>

        <p className="about-modal__stack">
          The launcher runs the local Semiont stack: Neo4j, Qdrant, Ollama, PostgreSQL, Jaeger, and the Semiont
          gateway, worker, smelter, weaver, and Browser. Try <code>semiont start --help</code>.
        </p>
        <p className="about-modal__tagline">✨ Make Meaning</p>
      </section>
    </div>
  );
}
