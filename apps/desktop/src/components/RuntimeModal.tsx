import { useEffect } from 'react';
import type { RuntimeInfo } from '../lib/runtime-info';
import { RUNTIME_INSTALL_LINKS, runtimeName } from '../lib/runtime-info';

export function RuntimeModal({ info, onClose }: { info: RuntimeInfo | null; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const hasRuntime = (runtime: keyof typeof RUNTIME_INSTALL_LINKS) => info?.detected.includes(runtime) ?? false;

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
          {info === null ? (
            <p>Checking the launcher…</p>
          ) : info.active.length > 0 ? (
            <ul className="runtime-modal__active-list">
              {info.active.map(({ runtime, runningServices }) => (
                <li key={runtime}>
                  <strong>{runtimeName(runtime)}</strong>
                  <span>{runningServices} running {runningServices === 1 ? 'service' : 'services'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>{info.statusAvailable ? 'No running Semiont services found.' : 'Could not read running services from the launcher.'}</p>
          )}
        </section>

        <section className="runtime-modal__section" aria-labelledby="runtime-detected-title">
          <h2 id="runtime-detected-title">Detected by launcher</h2>
          {info === null ? (
            <p>Checking installed runtimes…</p>
          ) : info.detected.length > 0 ? (
            <p>{info.detected.map(runtimeName).join(', ')}</p>
          ) : (
            <p>{info.statusAvailable ? 'No supported container runtime was detected on PATH.' : 'The launcher could not confirm a supported runtime.'}</p>
          )}
        </section>

        <section className="runtime-modal__section" aria-labelledby="runtime-install-title">
          <h2 id="runtime-install-title">Install a container runtime</h2>
          <ul className="runtime-modal__install-list">
            {(Object.keys(RUNTIME_INSTALL_LINKS) as Array<keyof typeof RUNTIME_INSTALL_LINKS>).map((runtime) => {
              const option = RUNTIME_INSTALL_LINKS[runtime];
              return (
                <li key={runtime}>
                  <a href={option.url} target="_blank" rel="noreferrer">
                    <span>{option.label}</span>
                    <small>{hasRuntime(runtime) ? 'Installed' : option.detail}</small>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      </section>
    </div>
  );
}
