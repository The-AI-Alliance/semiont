import { useEffect } from 'react';
import type { ControlServiceGroup, ControlServiceStatus } from '../../electron/control-types.gen';
import type { ControlAnswerState } from '../lib/launcher-bridge';
import { LauncherAnswer } from './LauncherAnswer';

/** The group semiont status reports the telemetry backends in. */
const TELEMETRY_GROUP: ControlServiceGroup = 'telemetry';

export function TelemetryModal({
  state,
  onClose,
}: {
  state: ControlAnswerState<'status.snapshot'>;
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
      <section className="config config--modal telemetry-modal" role="dialog" aria-modal="true" aria-labelledby="telemetry-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="telemetry-title">Telemetry</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close telemetry">
            ×
          </button>
        </header>
        <p className="telemetry-modal__hint">The observability services the launcher runs for every knowledge base.</p>
        <LauncherAnswer state={state}>
          {(snapshot) => {
            const services = snapshot.shared.filter((service) => service.group === TELEMETRY_GROUP);
            if (services.length === 0) {
              return <p className="launcher-answer__note">The launcher reports no telemetry services.</p>;
            }
            return (
              <ul className="telemetry-modal__services">
                {services.map((service) => (
                  <li key={service.role}>
                    <TelemetryServiceCard service={service} />
                  </li>
                ))}
              </ul>
            );
          }}
        </LauncherAnswer>
      </section>
    </div>
  );
}

function TelemetryServiceCard({ service }: { service: ControlServiceStatus }) {
  return (
    <article className="telemetry-service">
      <div className="telemetry-service__copy">
        <div className="telemetry-service__heading">
          <h2>{service.role}</h2>
          <span className={`telemetry-service__state telemetry-service__state--${service.healthy ? 'healthy' : 'unhealthy'}`}>
            {service.state}
          </span>
        </div>
        <p>
          {service.product !== undefined && <>{service.product} · </>}
          {service.healthy ? 'Answers' : 'Does not answer'}
        </p>
      </div>
      {service.page !== undefined ? (
        <a className="telemetry-service__open" href={service.page} target="_blank" rel="noreferrer">
          Open {service.role}
        </a>
      ) : (
        <span className="telemetry-service__open telemetry-service__open--disabled" aria-disabled="true">
          No page to open
        </span>
      )}
    </article>
  );
}
