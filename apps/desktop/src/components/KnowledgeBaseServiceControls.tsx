import { useEffect, useState } from 'react';
import type { KnowledgeBaseRow } from './KnowledgeBasesModal';

export function KnowledgeBaseServiceControls({
  root,
  onStart,
  onStop,
  onFollowLogs,
}: {
  root: KnowledgeBaseRow | null;
  onStart: (root: KnowledgeBaseRow) => void;
  onStop: (root: KnowledgeBaseRow) => void;
  onFollowLogs: (root: KnowledgeBaseRow) => void;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (root?.operationStartedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [root?.operationStartedAt]);

  return (
    <div className="service-group__controls">
      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-base-stack-heading">
        <h3 id="knowledge-base-stack-heading">Knowledge Base stack</h3>
        {root === null ? (
          <p className="knowledge-bases__action-note">Stack controls are available for local knowledge bases registered on this machine.</p>
        ) : (
          <>
            <div className="knowledge-bases__controls">
              {root.operation === 'starting' ? (
                <button type="button" className="kb__connect" disabled>Starting…</button>
              ) : root.operation === 'stopping' ? (
                <button type="button" className="kb__connect kb__connect--on" disabled>Stopping…</button>
              ) : root.status === 'running' ? (
                <button type="button" className="kb__connect kb__connect--on" disabled={root.operation !== undefined} onClick={() => onStop(root)}>Stop</button>
              ) : root.status === 'stopped' ? (
                <button type="button" className="kb__connect" disabled={root.operation !== undefined} onClick={() => onStart(root)}>Start</button>
              ) : (
                <>
                  <button type="button" className="kb__connect" disabled={root.operation !== undefined} onClick={() => onStart(root)}>Start / repair</button>
                  <button type="button" className="kb__connect kb__connect--on" disabled={root.operation !== undefined} onClick={() => onStop(root)}>Stop</button>
                </>
              )}
            </div>
            {root.operationError !== undefined && root.operationErrorAction === 'launcher' && <p className="knowledge-bases__action-error">{root.operationError}</p>}
            {root.operation !== undefined && (
              <div className="knowledge-bases__progress" role="status" aria-live="polite">
                <p>{root.operation === 'starting' ? 'Start progress' : 'Stop progress'} · {formatElapsed(root.operationStartedAt, now)}</p>
                {root.operationProgress === undefined || root.operationProgress.length === 0 ? (
                  <span className="knowledge-bases__progress-waiting">Checking service status; waiting for progress…</span>
                ) : (
                  <ol>
                    {root.operationProgress.slice(-5).map((progress, index) => (
                      <li key={`${progress.requestId}-${index}`} className={`knowledge-bases__progress--${progress.kind}`}>
                        {progress.kind === 'command' ? <code>{progress.text}</code> : progress.text}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
            {root.operation === undefined && root.operationProgress !== undefined && root.operationError !== undefined && (
              <div className="knowledge-bases__progress" aria-label="Progress before failure">
                <p>Last progress before failure</p>
                <ol>
                  {root.operationProgress.map((progress, index) => (
                    <li key={`${progress.requestId}-${index}`} className={`knowledge-bases__progress--${progress.kind}`}>
                      {progress.kind === 'command' ? <code>{progress.text}</code> : progress.text}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
      </section>

      <section className="knowledge-bases__detail-section" aria-labelledby="knowledge-base-service-logs-heading">
        <h3 id="knowledge-base-service-logs-heading">Logs</h3>
        {root === null ? (
          <p className="knowledge-bases__action-note">Log following is available for local knowledge bases registered on this machine.</p>
        ) : (
          <>
            <div className="knowledge-bases__controls">
              <button
                type="button"
                className="kb__connect"
                disabled={root.operation !== undefined || (root.status !== 'running' && root.status !== 'attention')}
                onClick={() => onFollowLogs(root)}
              >
                Follow logs
              </button>
            </div>
            {root.status !== 'running' && root.status !== 'attention' && (
              <p className="knowledge-bases__action-note">Start this knowledge base to follow its service logs.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function formatElapsed(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return 'in progress';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s elapsed` : `${minutes}m ${seconds % 60}s elapsed`;
}
