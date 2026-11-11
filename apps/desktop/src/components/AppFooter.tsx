import { useEffect, useState } from 'react';
import type { ControlWorkloadStatusQueue } from '../../electron/control-types.gen';
import type { ControlOutcome, LauncherBridge } from '../lib/launcher-bridge';
import { ViewerPrefControls, type ViewerPrefs } from './ViewerPrefControls';

const QUEUE_REFRESH_INTERVAL_MS = 30_000;

/** Main-pane app chrome: global resource-view preferences. */
export function AppFooter({ prefs, activeRootPath, onOpenDispatcherMessaging }: {
  prefs: ViewerPrefs;
  activeRootPath: string | null;
  onOpenDispatcherMessaging: () => void;
}) {
  return (
    <div className="appfooter">
      <div className="appfooter__right">
        {activeRootPath !== null && <QueueStatusIndicator rootPath={activeRootPath} onClick={onOpenDispatcherMessaging} />}
        <ViewerPrefControls prefs={prefs} />
      </div>
    </div>
  );
}

type QueueState =
  | { status: 'loading' }
  | { status: 'ready'; queue: ControlWorkloadStatusQueue; sampledAt: number }
  | { status: 'waiting' }
  | { status: 'unavailable' };

function requestQueue(bridge: LauncherBridge, rootPath: string): Promise<ControlOutcome<'status.snapshot'>> {
  return new Promise((resolve, reject) => {
    void bridge.startControl('status.snapshot', { target: { kind: 'local', root: rootPath } }, (event) => {
      if (event.kind === 'answer') resolve(event.outcome);
    }).catch(reject);
  });
}

function QueueStatusIndicator({ rootPath, onClick }: { rootPath: string; onClick: () => void }) {
  const [state, setState] = useState<QueueState>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      const bridge = window.launcherBridge;
      if (bridge === undefined) {
        setState({ status: 'unavailable' });
        return;
      }
      inFlight = true;
      void requestQueue(bridge, rootPath).then((outcome) => {
        if (!current) return;
        if (!outcome.ok) {
          setState({ status: 'unavailable' });
          return;
        }
        const kb = outcome.result.knowledgeBases.find((candidate) => candidate.root === rootPath);
        const queue = kb?.workload?.queue;
        setState(queue === undefined ? { status: 'waiting' } : { status: 'ready', queue, sampledAt: Date.now() });
      }).catch(() => {
        if (current) setState({ status: 'unavailable' });
      }).finally(() => {
        inFlight = false;
      });
    };

    refresh();
    const interval = window.setInterval(refresh, QUEUE_REFRESH_INTERVAL_MS);
    return () => {
      current = false;
      window.clearInterval(interval);
    };
  }, [rootPath]);

  const title = state.status === 'ready'
    ? `Job queue, refreshed ${new Date(state.sampledAt).toLocaleTimeString()}. Completed ${state.queue.completed ?? 'not reported'} and failed ${state.queue.failed ?? 'not reported'} since worker start.`
    : state.status === 'waiting'
      ? 'Job queue metrics are not available yet.'
      : state.status === 'unavailable'
        ? 'Job queue status is unavailable.'
        : 'Loading job queue status.';

  return (
    <button
      type="button"
      className={`appfooter__queue${state.status === 'ready' && state.queue.failed !== undefined && state.queue.failed > 0 ? ' appfooter__queue--failed' : ''}`}
      title={title}
      aria-label={`${title} Open Dispatcher and Messaging details.`}
      onClick={onClick}
    >
      <span className="appfooter__queue-label">Queue</span>
      {state.status === 'ready' ? (
        <>
          <span><i className="appfooter__queue-dot appfooter__queue-dot--pending" />{state.queue.pending} pending</span>
          <span><i className="appfooter__queue-dot appfooter__queue-dot--running" />{state.queue.running} running</span>
          {state.queue.failed !== undefined && state.queue.failed > 0 && <span className="appfooter__queue-failures">{state.queue.failed} failed</span>}
        </>
      ) : (
        <span className="appfooter__queue-muted">{state.status === 'loading' ? 'Loading…' : state.status === 'waiting' ? 'Waiting for metrics' : 'Unavailable'}</span>
      )}
    </button>
  );
}
