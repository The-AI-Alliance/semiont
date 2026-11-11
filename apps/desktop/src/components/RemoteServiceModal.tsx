import { useEffect } from 'react';

export type RemoteService = 'inference' | 'knowledge-workers' | 'identity';

const TITLES: Record<RemoteService, string> = {
  inference: 'Inference & Embedding',
  'knowledge-workers': 'Knowledge Workers',
  identity: 'Identity',
};

export function RemoteServiceModal({ service, onClose }: { service: RemoteService; onClose: () => void }) {
  const title = TITLES[service];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal remote-service-modal" role="dialog" aria-modal="true" aria-labelledby="remote-service-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="remote-service-title">{title}</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label={`Close remote ${title}`}>
            ×
          </button>
        </header>
        <p>Remote {title.toLowerCase()} status and controls will be available here.</p>
      </section>
    </div>
  );
}
