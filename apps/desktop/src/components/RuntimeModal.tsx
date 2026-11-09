import { useEffect } from 'react';
import type { ControlRuntime, ControlStatusSnapshotResult } from '../../electron/control-types.gen';
import type { ControlAnswerState } from '../lib/launcher-bridge';
import { LauncherAnswer } from './LauncherAnswer';

/** Each container runtime the launcher drives, as a person knows it, and where to get it. */
const RUNTIME_GUIDES: Record<ControlRuntime, { name: string; install: string; url: string; detail: string }> = {
  container: {
    name: 'Apple Container',
    install: 'Apple Container',
    url: 'https://github.com/apple/container',
    detail: 'macOS 26 or later, Apple silicon',
  },
  docker: {
    name: 'Docker',
    install: 'Docker Desktop',
    url: 'https://docs.docker.com/desktop/setup/install/mac-install/',
    detail: 'Official Mac installer',
  },
  podman: {
    name: 'Podman',
    install: 'Podman',
    url: 'https://podman.io/docs/installation',
    detail: 'Official installation guide',
  },
};

/** Whether a service's runsOn names a container runtime, rather than external or host. */
function isRuntime(runsOn: string): runsOn is ControlRuntime {
  return Object.hasOwn(RUNTIME_GUIDES, runsOn);
}

/** Each runtime the snapshot's running services run under, with how many run under it. */
function runtimesInUse(snapshot: ControlStatusSnapshotResult): Array<{ runtime: ControlRuntime; running: number }> {
  const services = [...snapshot.knowledgeBases.flatMap((kb) => kb.services), ...snapshot.shared];
  const running = services.flatMap(({ state, runsOn }) =>
    state === 'running' && runsOn !== undefined && isRuntime(runsOn) ? [runsOn] : []);
  return [...new Set(running)].map((runtime) => ({
    runtime,
    running: running.filter((runsOn) => runsOn === runtime).length,
  }));
}

export function RuntimeModal({
  status,
  about,
  onClose,
}: {
  status: ControlAnswerState<'status.snapshot'>;
  about: ControlAnswerState<'launcher.about'>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const installed = (runtime: string): boolean =>
    about.status === 'answered'
    && about.outcome.ok
    && about.outcome.result.runtimes.some(({ name, found }) => found && name === runtime);

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal runtime-modal" role="dialog" aria-modal="true" aria-labelledby="runtime-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="runtime-title">Container runtime</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close container runtime">
            ×
          </button>
        </header>

        <section className="runtime-modal__section" aria-labelledby="runtime-active-title">
          <h2 id="runtime-active-title">In use</h2>
          <LauncherAnswer state={status}>
            {(snapshot) => {
              const inUse = runtimesInUse(snapshot);
              if (inUse.length === 0) return <p>No Semiont services are running.</p>;
              return (
                <ul className="runtime-modal__active-list">
                  {inUse.map(({ runtime, running }) => (
                    <li key={runtime}>
                      <strong>{RUNTIME_GUIDES[runtime].name}</strong>
                      <span>{running} running {running === 1 ? 'service' : 'services'}</span>
                    </li>
                  ))}
                </ul>
              );
            }}
          </LauncherAnswer>
        </section>

        <section className="runtime-modal__section" aria-labelledby="runtime-detected-title">
          <h2 id="runtime-detected-title">Detected by launcher</h2>
          <LauncherAnswer state={about}>
            {({ runtimes }) => {
              const detected = runtimes.filter(({ found }) => found);
              return detected.length > 0
                ? <p>{detected.map(({ name }) => RUNTIME_GUIDES[name].name).join(', ')}</p>
                : <p>The launcher found no container runtime it drives on its PATH.</p>;
            }}
          </LauncherAnswer>
        </section>

        <section className="runtime-modal__section" aria-labelledby="runtime-install-title">
          <h2 id="runtime-install-title">Install a container runtime</h2>
          <ul className="runtime-modal__install-list">
            {Object.entries(RUNTIME_GUIDES).map(([runtime, guide]) => (
              <li key={runtime}>
                <a href={guide.url} target="_blank" rel="noreferrer">
                  <span>{guide.install}</span>
                  <small>{installed(runtime) ? 'Installed' : guide.detail}</small>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </section>
    </div>
  );
}
