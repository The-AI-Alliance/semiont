import { useEffect } from 'react';
import type {
  ControlKnowledgeBaseStatus,
  ControlServiceStatus,
  ControlStatusSnapshotResult,
} from '../../electron/control-types.gen';
import type { ControlAnswerState } from '../lib/launcher-bridge';
import { LauncherAnswer } from './LauncherAnswer';

export function LauncherStatusModal({
  state,
  onRefresh,
  onClose,
}: {
  state: ControlAnswerState<'status.snapshot'>;
  onRefresh: () => void;
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
        className="config config--modal config--launcher-status"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launcher-status-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="config__head">
          <h1 id="launcher-status-title">Status</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close launcher status">
            ×
          </button>
        </header>

        <div className="launcher-status__body">
          <LauncherAnswer state={state}>{(snapshot) => <Snapshot snapshot={snapshot} />}</LauncherAnswer>
        </div>

        {state.status === 'answered' && (
          <div className="launcher-status__actions">
            <button type="button" className="kb__connect" onClick={onRefresh}>
              Run again
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function Snapshot({ snapshot }: { snapshot: ControlStatusSnapshotResult }) {
  return (
    <>
      {snapshot.knowledgeBases.length === 0 && (
        <p className="launcher-status__note">The launcher knows of no knowledge base.</p>
      )}
      {snapshot.knowledgeBases.map((kb) => (
        <KnowledgeBase key={`${kb.placement}/${kb.key}`} kb={kb} />
      ))}
      {snapshot.shared.length > 0 && (
        <section className="launcher-status__kb" aria-labelledby="launcher-status-shared">
          <div className="launcher-status__kb-head">
            <h2 id="launcher-status-shared">Shared services</h2>
          </div>
          <ServiceTable services={snapshot.shared} shared />
        </section>
      )}
    </>
  );
}

function KnowledgeBase({ kb }: { kb: ControlKnowledgeBaseStatus }) {
  return (
    <section className="launcher-status__kb" aria-label={`Knowledge base ${kb.name}`}>
      <div className="launcher-status__kb-head">
        <h2>{kb.name}</h2>
        <span className={`launcher-status__badge launcher-status__badge--${kb.healthy ? 'healthy' : 'unhealthy'}`}>
          {kb.healthy ? 'Healthy' : 'Not healthy'}
        </span>
        {kb.starting && <span className="launcher-status__badge">Starting</span>}
      </div>
      <dl className="launcher-status__facts">
        {knowledgeBaseFacts(kb).map(([term, detail]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{detail}</dd>
          </div>
        ))}
      </dl>
      {kb.identityError !== undefined && (
        <p className="launcher-answer__failure">Its identity could not be read: {kb.identityError}</p>
      )}
      {kb.services.length > 0 ? (
        <ServiceTable services={kb.services} shared={false} />
      ) : (
        <p className="launcher-status__note">
          {kb.placement === 'codespace'
            ? 'The launcher in its codespace reports its services.'
            : 'It has no services of its own.'}
        </p>
      )}
    </section>
  );
}

/** What the snapshot states of a knowledge base, as term and detail; what it leaves out is
 *  left out. */
function knowledgeBaseFacts(kb: ControlKnowledgeBaseStatus): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  if (kb.siteName !== undefined) facts.push(['Site', kb.siteName]);
  if (kb.did !== undefined) facts.push(['DID', kb.did]);
  facts.push(['Placement', kb.placement]);
  if (kb.root !== undefined) facts.push(['Clone', kb.root]);
  if (kb.repo !== undefined) facts.push(['Repository', kb.repo]);
  facts.push(['Key', kb.key]);
  facts.push(['Recorded', kb.recorded ? 'Yes' : 'No: its services are found by name']);
  if (kb.runtime !== undefined) facts.push(['Runtime', kb.runtime]);
  if (kb.gateway !== undefined) facts.push(['Gateway', kb.gateway]);
  if (kb.kb !== undefined) facts.push(['Published at', `${kb.kb.host}:${kb.kb.port}`]);
  if (kb.lan !== undefined) facts.push(['LAN address', kb.lan]);
  if (kb.secretStore !== undefined) facts.push(['Secret store', kb.secretStore]);
  if (kb.session !== undefined) {
    const { state, email } = kb.session;
    facts.push(['Launcher sign-in', email === undefined ? state : `${state}, as ${email}`]);
  }
  return facts;
}

function ServiceTable({ services, shared }: { services: ControlServiceStatus[]; shared: boolean }) {
  return (
    <div className="launcher-status__services">
      <table>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Group</th>
            <th scope="col">Runs on</th>
            <th scope="col">State</th>
            <th scope="col">Health</th>
            <th scope="col">Page</th>
            <th scope="col">Probe</th>
            {shared && <th scope="col">Serves</th>}
          </tr>
        </thead>
        <tbody>
          {services.map((service) => (
            <tr key={`${service.group}/${service.role}`}>
              <th scope="row">
                {service.role}
                {service.product !== undefined && <small>{service.product}</small>}
                {service.realm !== undefined && <small>realm {service.realm}</small>}
              </th>
              <td>{service.group}</td>
              <td>{service.runsOn}</td>
              <td>
                {service.containerState === undefined
                  ? service.state
                  : `${service.state} (${service.containerState})`}
              </td>
              <td className={service.healthy ? 'launcher-status__healthy' : 'launcher-status__unhealthy'}>
                {service.healthy ? 'Answers' : 'Does not answer'}
                {!service.counted && <small>not counted</small>}
              </td>
              <td>
                {service.page !== undefined && (
                  <a href={service.page} target="_blank" rel="noreferrer">Open</a>
                )}
              </td>
              <td>{service.probe !== undefined && <code>{service.probe}</code>}</td>
              {shared && <td>{service.serves !== undefined && service.serves.join(', ')}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
