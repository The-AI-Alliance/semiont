import { useEffect, useState } from 'react';
import type { McpProcessStatus } from '../lib/launcher-bridge';

export function McpModal({
  status,
  onStart,
  onStop,
  onClose,
}: {
  status: McpProcessStatus;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (status.state !== 'running') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status.state]);

  const running = status.state === 'running';
  const busy = status.state === 'starting' || status.state === 'stopping';

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal mcp-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <h1 id="mcp-title">MCP</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close MCP status">
            ×
          </button>
        </header>

        <section className="mcp-modal__status" aria-live="polite">
          <div className="mcp-modal__status-heading">
            <span className={`mcp-modal__indicator${running ? ' mcp-modal__indicator--running' : ''}`} aria-hidden="true" />
            <strong>{statusLabel(status.state)}</strong>
          </div>
          {status.error !== null && <p className="mcp-modal__error">{status.error}</p>}
          {running && (
            <dl className="mcp-modal__stats">
              <div><dt>Process ID</dt><dd>{status.pid ?? '—'}</dd></div>
              <div><dt>Uptime</dt><dd>{formatElapsed(now - (status.startedAt ?? now))}</dd></div>
              <div><dt>Memory</dt><dd>{status.memoryBytes === null ? '—' : `${(status.memoryBytes / 1024 / 1024).toFixed(1)} MiB`}</dd></div>
              <div><dt>CPU average</dt><dd>{status.cpuPercent === null ? '—' : `${status.cpuPercent.toFixed(1)}%`}</dd></div>
            </dl>
          )}
          {!running && !busy && status.state !== 'failed' && <p>Start the Desktop-managed `semiont mcp` process.</p>}
        </section>

        <p className="mcp-modal__note">
          This MCP server uses stdio. External clients can run their own <code>semiont mcp</code> process or use the Semiont SDK.
        </p>

        <footer className="mcp-modal__actions">
          {running ? (
            <button type="button" className="mcp-modal__stop" onClick={onStop}>Stop MCP</button>
          ) : (
            <button type="button" onClick={onStart} disabled={busy}>
              {status.state === 'starting' ? 'Starting…' : status.state === 'stopping' ? 'Stopping…' : 'Start MCP'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function statusLabel(state: McpProcessStatus['state']): string {
  switch (state) {
    case 'starting': return 'Starting';
    case 'running': return 'Running';
    case 'stopping': return 'Stopping';
    case 'failed': return 'Failed';
    case 'stopped': return 'Stopped';
  }
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${remainingSeconds}s`
    : minutes > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${remainingSeconds}s`;
}
