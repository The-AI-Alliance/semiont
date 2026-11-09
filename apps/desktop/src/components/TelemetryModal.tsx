import { useEffect, useState } from 'react';
import type { TelemetryLinks, TelemetryService, TelemetryServiceState } from '../lib/telemetry-links';

const services = [
  { key: 'traces', label: 'Traces', product: 'Jaeger', description: 'Search and inspect distributed traces' },
  { key: 'metrics', label: 'Metrics', product: 'Prometheus', description: 'Explore service metrics over time' },
] as const;

export function TelemetryModal({ links, onClose }: { links: TelemetryLinks; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal telemetry-modal" role="dialog" aria-modal="true" aria-labelledby="telemetry-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="telemetry-title">Telemetry</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close telemetry">
            ×
          </button>
        </header>
        <p className="telemetry-modal__hint">Local observability tools provided by the launcher.</p>
        <ul className="telemetry-modal__services">
          {services.map(({ key, label, product, description }) => (
            <li key={key}>
              <TelemetryServiceCard label={label} product={product} description={description} service={links[key]} />
            </li>
          ))}
        </ul>
        <details className="telemetry-modal__advanced">
          <summary>Advanced diagnostics</summary>
          <div className="telemetry-modal__collector">
            <div>
              <div className="telemetry-service__heading">
                <strong>Collector readout</strong>
                <span className={`telemetry-service__state telemetry-service__state--${links.collector.state}`}>
                  {stateLabel(links.collector.state)}
                </span>
              </div>
              <p>Raw OpenTelemetry Collector metrics. This endpoint has no dashboard.</p>
              <code>{links.collector.url}</code>
            </div>
            <div className="telemetry-modal__collector-actions">
              <a href={links.collector.url} target="_blank" rel="noreferrer">Open readout</a>
              <button type="button" onClick={() => {
                void navigator.clipboard?.writeText(links.collector.url).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                });
              }}>{copied ? 'Copied' : 'Copy URL'}</button>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}

function TelemetryServiceCard({
  label,
  product,
  description,
  service,
}: {
  label: string;
  product: string;
  description: string;
  service: TelemetryService;
}) {
  return (
    <article className="telemetry-service">
      <div className="telemetry-service__copy">
        <div className="telemetry-service__heading">
          <h2>{label}</h2>
          <span className={`telemetry-service__state telemetry-service__state--${service.state}`}>
            {stateLabel(service.state)}
          </span>
        </div>
        <p>{product} · {description}</p>
      </div>
      {service.state === 'stopped' ? (
        <span className="telemetry-service__open telemetry-service__open--disabled" aria-disabled="true">
          Stopped
        </span>
      ) : (
        <a className="telemetry-service__open" href={service.url} target="_blank" rel="noreferrer">
          Open {product}
        </a>
      )}
    </article>
  );
}

function stateLabel(state: TelemetryServiceState): string {
  switch (state) {
    case 'running': return 'Running';
    case 'unhealthy': return 'Unhealthy';
    case 'stopped': return 'Stopped';
    default: return 'Unknown';
  }
}
