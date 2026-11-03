import type { LauncherStatusResult } from '../lib/launcher-bridge';

export type LauncherStatusState =
  | { status: 'loading' }
  | { status: 'result'; result: LauncherStatusResult };

export function LauncherStatusModal({
  state,
  onRefresh,
  onClose,
}: {
  state: LauncherStatusState;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const output = state.status === 'loading' ? 'Running semiont status…' : state.result.output;

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
          <h1 id="launcher-status-title">Launcher status</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close launcher status">
            ×
          </button>
        </header>

        <pre className="launcher-status__output">{output}</pre>

        {state.status === 'result' && (
          <div className="launcher-status__actions">
            <span className={state.result.exitCode === 0 ? 'launcher-status__success' : 'launcher-status__failure'}>
              {state.result.error !== null
                ? `Launcher exited ${state.result.exitCode ?? 'without a status code'}: ${state.result.error}`
                : `Launcher exited ${state.result.exitCode}`}
            </span>
            <button type="button" className="kb__connect" onClick={onRefresh}>
              Run again
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
