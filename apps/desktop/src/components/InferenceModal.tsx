import { useEffect } from 'react';
import type { OllamaInfo } from '../lib/ollama-info';

const OLLAMA_DOWNLOAD = 'https://ollama.com/download';

export function InferenceModal({
  info,
  unavailable,
  onClose,
}: {
  info: OllamaInfo | null;
  unavailable: boolean;
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
        className="config config--modal inference-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inference-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="config__head">
          <h1 id="inference-title">Inference</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close Inference information">
            ×
          </button>
        </header>

        <section className="inference-modal__section" aria-labelledby="inference-ollama-title" aria-live="polite">
          <h2 id="inference-ollama-title">Ollama</h2>
          {unavailable ? (
            <p>Desktop could not check Ollama.</p>
          ) : info === null ? (
            <p>Checking whether Ollama is installed…</p>
          ) : (
            <>
              {info.executablePath !== null ? (
                <p className="inference-modal__available"><strong>Ollama is installed.</strong> <code>{info.executablePath}</code></p>
              ) : info.endpoint !== null ? (
                <p className="inference-modal__available"><strong>Ollama is responding.</strong> Its CLI was not found on Desktop’s PATH.</p>
              ) : (
                <p className="inference-modal__missing">Ollama was not found on Desktop’s PATH or local service endpoints.</p>
              )}
              {info.endpoint !== null && <p className="inference-modal__endpoint">Service: <code>{info.endpoint}</code></p>}
            </>
          )}
          <a className="inference-modal__download" href={OLLAMA_DOWNLOAD} target="_blank" rel="noreferrer">
            Download Ollama
          </a>
        </section>

        <p className="inference-modal__intro">
          Ollama can serve local language models and embeddings for a knowledge base. One Ollama instance can serve both.
        </p>

        <section className="inference-modal__section" aria-labelledby="inference-llm-title">
          <h2 id="inference-llm-title">LLMs</h2>
          <p>
            Language models generate text and structured responses for worker and librarian tasks. Each knowledge base
            selects its provider and models in <code>.semiont/stack/inference/</code>. Providers can be Ollama or a
            supported remote service.
          </p>
        </section>

        <section className="inference-modal__section" aria-labelledby="inference-embeddings-title">
          <h2 id="inference-embeddings-title">Embeddings</h2>
          <p>
            An embedding model turns document chunks and search queries into vectors for semantic search. The model is
            selected in <code>.semiont/stack/index.yaml</code>. Ollama and Voyage are supported embedding providers.
          </p>
        </section>

        <p className="inference-modal__note">
          When a knowledge base uses Ollama, the launcher uses an Ollama already installed on the machine when available,
          or starts one in a container. It pulls the configured models as needed.
        </p>

        <section className="inference-modal__section" aria-labelledby="inference-models-title" aria-live="polite">
          <h2 id="inference-models-title">Installed models</h2>
          {info === null ? (
            <p>{unavailable ? 'Model details are unavailable.' : 'Checking installed models…'}</p>
          ) : info.endpoint === null ? (
            <p>Start Ollama to list installed models.</p>
          ) : info.models.length === 0 ? (
            <p>Ollama is running, but no models are installed.</p>
          ) : (
            <ul className="inference-modal__models">
              {info.models.map((model) => (
                <li key={model.name}>
                  <strong>{model.name}</strong>
                  <span>
                    {[model.parameterSize, model.quantizationLevel, formatModelSize(model.sizeBytes), model.loaded ? 'Loaded' : 'Not loaded']
                      .filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <nav className="inference-modal__links" aria-label="Ollama resources">
          <a href="https://ollama.com/library" target="_blank" rel="noreferrer">Browse Ollama models</a>
          <a href="https://docs.ollama.com/" target="_blank" rel="noreferrer">Ollama documentation</a>
          <a href="https://github.com/The-AI-Alliance/semiont/blob/main/docs/operator/administration/CONFIGURATION.md" target="_blank" rel="noreferrer">
            Semiont model configuration
          </a>
        </nav>
      </section>
    </div>
  );
}

function formatModelSize(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
