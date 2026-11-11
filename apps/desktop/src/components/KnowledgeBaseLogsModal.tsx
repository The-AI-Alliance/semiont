import { useEffect, useRef, useState } from 'react';
import { controlFailureText, type ControlHandle } from '../lib/launcher-bridge';
import type { ControlLogRecord } from '../../electron/control-types.gen';
import type { KnowledgeBaseRow } from './KnowledgeBasesModal';

const MAX_LOG_LINES = 1000;

type FollowState =
  | { status: 'starting' }
  | { status: 'following' }
  | { status: 'stopped'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'unavailable'; message: string };

export function KnowledgeBaseLogsModal({ root, onClose }: { root: KnowledgeBaseRow; onClose: () => void }) {
  const [state, setState] = useState<FollowState>({ status: 'starting' });
  const [records, setRecords] = useState<ControlLogRecord[]>([]);
  const [handle, setHandle] = useState<ControlHandle | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const title = root.siteName || root.path.split(/[\\/]/u).filter(Boolean).at(-1) || root.path;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const bridge = window.launcherBridge;
    if (bridge === undefined) {
      setState({ status: 'unavailable', message: 'Log following is available in the desktop app only.' });
      return;
    }

    let disposed = false;
    let requestHandle: ControlHandle | null = null;
    let cancelWhenReady = false;
    let settled = false;
    void bridge.startControl('logs.follow', { target: { kind: 'local', root: root.path } }, (event) => {
      if (disposed) return;
      if (event.kind === 'answer') {
        settled = true;
        setHandle(null);
        if (event.outcome.ok) setState({ status: 'stopped', message: 'The log sources ended.' });
        else if (event.outcome.error.kind === 'answered' && event.outcome.error.data?.code === 'control.cancelled') {
          setState({ status: 'stopped', message: 'Stopped following logs.' });
        } else {
          const failure = event.outcome.ok ? '' : controlFailureText(event.outcome.error);
          setState({ status: 'failed', message: failure });
        }
        return;
      }
      if (event.notice.method !== 'notifications/log') return;
      const record = event.notice.params;
      setState({ status: 'following' });
      setRecords((current) => [...current, record].slice(-MAX_LOG_LINES));
    }).then((startedHandle) => {
      requestHandle = startedHandle;
      if (disposed || cancelWhenReady) {
        bridge.cancelControl(startedHandle, 'the log view closed before following began');
        return;
      }
      if (!settled) {
        setHandle(startedHandle);
        setState({ status: 'following' });
      }
    }).catch((error: unknown) => {
      if (disposed) return;
      setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
    });

    return () => {
      disposed = true;
      if (requestHandle !== null) bridge.cancelControl(requestHandle, 'the log view closed');
      else cancelWhenReady = true;
    };
  }, [root.path]);

  useEffect(() => {
    const output = outputRef.current;
    if (output !== null) output.scrollTop = output.scrollHeight;
  }, [records]);

  const stopFollowing = () => {
    const bridge = window.launcherBridge;
    if (bridge === undefined || handle === null) return;
    setCancelRequested(true);
    bridge.cancelControl(handle, 'the person stopped following logs');
  };

  return (
    <div className="modal modal--nested" onClick={onClose}>
      <section className="config config--modal knowledge-base-logs" role="dialog" aria-modal="true" aria-labelledby="knowledge-base-logs-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <div>
            <h1 id="knowledge-base-logs-title">Logs · {title}</h1>
            <p className="knowledge-base-logs__path">{root.path}</p>
          </div>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close logs">×</button>
        </header>
        <p className="knowledge-base-logs__hint">Following the default Semiont service logs for this knowledge base. Lines are shown live and are not saved by Desktop.</p>
        <div className="knowledge-base-logs__output" ref={outputRef} role="log" aria-live="polite" aria-relevant="additions text">
          {records.length === 0 ? (
            <p className="knowledge-base-logs__empty">{state.status === 'following' ? 'Waiting for log output…' : 'Starting log follow…'}</p>
          ) : records.map((record, index) => (
            <div className="knowledge-base-logs__line" key={`${record.requestId}-${record.receivedAt}-${index}`}>
              <time dateTime={record.receivedAt}>{formatTime(record.receivedAt)}</time>
              <strong>{record.service}</strong>
              <span className={record.stream === 'stderr' ? 'knowledge-base-logs__stderr' : undefined}>{record.line || ' '}</span>
            </div>
          ))}
        </div>
        {state.status === 'failed' || state.status === 'unavailable' || state.status === 'stopped' ? (
          <p className={state.status === 'failed' ? 'knowledge-bases__action-error' : 'knowledge-base-logs__hint'}>{state.message}</p>
        ) : null}
        <footer className="knowledge-base-logs__footer">
          {state.status === 'following' && handle !== null && (
            <button type="button" className="kb__connect" disabled={cancelRequested} onClick={stopFollowing}>
              {cancelRequested ? 'Stopping…' : 'Stop following'}
            </button>
          )}
          <button type="button" className="kb__connect" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}
