import { Fragment, useEffect, useState } from 'react';
import type {
  ControlKnowledgeBaseStatus,
  ControlServiceGroup,
  ControlServiceStatus,
  ControlTarget,
} from '../../electron/control-types.gen';
import type { ControlAnswerState, ControlEvent, ControlFailure } from '../lib/launcher-bridge';
import { controlFailureText } from '../lib/launcher-bridge';
import type { ControlStatusSnapshotResult } from '../../electron/control-types.gen';
import { LauncherAnswer } from './LauncherAnswer';
import { GitStatusSection, type GitCheck } from './GitStatusSection';
import { KnowledgeBaseServiceControls } from './KnowledgeBaseServiceControls';
import type { KnowledgeBaseRow } from './KnowledgeBasesModal';

type KnowledgeBaseServiceModal = 'gateway-archivist' | 'dispatcher-messaging';
export type DesktopServiceGroup = Extract<ControlServiceGroup, 'index' | 'knowledge-workers' | 'issuer'> | 'browser' | KnowledgeBaseServiceModal;
type Action = 'start' | 'stop';
interface ServiceRow {
  key: string;
  kbName?: string;
  service: ControlServiceStatus;
  target?: ControlTarget;
}

const GROUP_TITLES: Record<DesktopServiceGroup, string> = {
  'gateway-archivist': 'Gateway & Archivist',
  'dispatcher-messaging': 'Dispatcher & Messaging',
  index: 'Index',
  'knowledge-workers': 'Knowledge Workers',
  browser: 'Browser',
  issuer: 'Identity & Stores',
};

const GROUP_DESCRIPTIONS: Record<DesktopServiceGroup, string> = {
  'gateway-archivist': 'Gateway and Archivist status, launcher controls, logs, and Git for this knowledge base.',
  'dispatcher-messaging': 'Dispatcher and Messaging status for this knowledge base.',
  index: 'Index services for search, extraction, graph, and vector data.',
  'knowledge-workers': 'Shared workers that process jobs for knowledge bases on this machine.',
  browser: 'The shared Browser service for knowledge bases on this machine.',
  issuer: 'Identity services and their stores, listed for each knowledge base.',
};

export function ServiceGroupModal({
  group,
  state,
  selectedRootPath,
  knowledgeBaseRoot,
  gitCheck,
  onStartKnowledgeBase,
  onStopKnowledgeBase,
  onFollowLogs,
  onRefresh,
  onClose,
}: {
  group: DesktopServiceGroup;
  state: ControlAnswerState<'status.snapshot'>;
  selectedRootPath: string | null;
  knowledgeBaseRoot: KnowledgeBaseRow | null;
  gitCheck: GitCheck;
  onStartKnowledgeBase: (root: KnowledgeBaseRow) => void;
  onStopKnowledgeBase: (root: KnowledgeBaseRow) => void;
  onFollowLogs: (root: KnowledgeBaseRow) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState<{ key: string; action: Action } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const operate = (row: ServiceRow, action: Action) => {
    const bridge = window.launcherBridge;
    if (bridge === undefined || row.target === undefined || pending !== null) return;
    setPending({ key: row.key, action });
    setProgress(null);
    setError(null);

    const finish = (failure?: ControlFailure) => {
      setPending(null);
      setProgress(null);
      if (failure === undefined) onRefresh();
      else setError(controlFailureText(failure));
    };
    const onStartEvent = (event: ControlEvent<'stack.start'>) => {
      if (event.kind === 'answer') {
        if (event.outcome.ok) finish();
        else finish(event.outcome.error);
      } else if (event.notice.method === 'notifications/progress') {
        setProgress(event.notice.params.text);
      }
    };
    const onStopEvent = (event: ControlEvent<'stack.stop'>) => {
      if (event.kind === 'answer') {
        if (event.outcome.ok) finish();
        else finish(event.outcome.error);
      } else if (event.notice.method === 'notifications/progress') {
        setProgress(event.notice.params.text);
      }
    };

    const request = action === 'start'
      ? bridge.startControl('stack.start', { target: row.target, service: row.service.role }, onStartEvent)
      : bridge.startControl('stack.stop', { target: row.target, service: row.service.role }, onStopEvent);
    void request.catch((cause: unknown) => {
      setPending(null);
      setProgress(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal config--service-group" role="dialog" aria-modal="true" aria-labelledby="service-group-title" onClick={(event) => event.stopPropagation()}>
        <header className="config__head">
          <div>
            <h1 id="service-group-title">{GROUP_TITLES[group]}</h1>
            <p className="service-group__intro">{GROUP_DESCRIPTIONS[group]}</p>
          </div>
          <button type="button" className="config__close" onClick={onClose} aria-label={`Close ${GROUP_TITLES[group]}`}>×</button>
        </header>

        <div className="service-group__body">
          {group === 'gateway-archivist' && (
            <KnowledgeBaseServiceControls
              root={knowledgeBaseRoot}
              onStart={onStartKnowledgeBase}
              onStop={onStopKnowledgeBase}
              onFollowLogs={onFollowLogs}
            />
          )}
          <LauncherAnswer state={state}>
            {(snapshot) => <SnapshotServices snapshot={snapshot} group={group} selectedRootPath={selectedRootPath} gitCheck={gitCheck} onOperate={operate} pending={pending} />}
          </LauncherAnswer>
          {progress !== null && <p className="service-group__progress" role="status" aria-live="polite">{progress}</p>}
          {error !== null && <p className="knowledge-bases__action-error" role="alert">{error}</p>}
        </div>

        <footer className="service-group__footer">
          <button type="button" className="kb__connect" onClick={onRefresh} disabled={pending !== null}>Refresh</button>
        </footer>
      </section>
    </div>
  );
}

function SnapshotServices({
  snapshot,
  group,
  selectedRootPath,
  gitCheck,
  onOperate,
  pending,
}: {
  snapshot: ControlStatusSnapshotResult;
  group: DesktopServiceGroup;
  selectedRootPath: string | null;
  gitCheck: GitCheck;
  onOperate: (row: ServiceRow, action: Action) => void;
  pending: { key: string; action: Action } | null;
}) {
  const rows = rowsForGroup(snapshot, group, selectedRootPath);
  const knowledgeBaseServiceModal = isKnowledgeBaseServiceModal(group);
  if (knowledgeBaseServiceModal && selectedRootPath === null) {
    return (
      <>
        <p className="service-group__empty">Open a local Knowledge Base tab to see and control its services.</p>
        {group === 'gateway-archivist' && <GitStatusSection check={gitCheck} />}
      </>
    );
  }
  if (rows.length === 0) {
    if (knowledgeBaseServiceModal) {
      return (
        <>
          <p className="service-group__empty">No {GROUP_TITLES[group]} services are reported.</p>
          {group === 'gateway-archivist' && <GitStatusSection check={gitCheck} />}
        </>
      );
    }
    return <p className="service-group__empty">No {GROUP_TITLES[group]} services are reported.</p>;
  }

  return (
    <>
      {(group === 'index' || group === 'knowledge-workers' || group === 'browser') && selectedRootPath === null && (
        <p className="service-group__empty">Open a local Knowledge Base tab to control these shared services.</p>
      )}
      <div className="launcher-status__services">
        <table>
          <thead>
            <tr>
              {group === 'issuer' && <th scope="col">Knowledge Base</th>}
              <th scope="col">Service</th>
              <th scope="col">Runs on</th>
              <th scope="col">State</th>
              <th scope="col">Health</th>
              {group === 'issuer' && <th scope="col">Realm</th>}
              {!knowledgeBaseServiceModal && group !== 'issuer' && <th scope="col">Serves</th>}
              <th scope="col">Page / Probe</th>
              <th scope="col">Control</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
            const canStart = row.target !== undefined && !isExternallyManaged(row.service) && (row.service.state === 'stopped' || row.service.state === 'absent');
            const canStop = row.target !== undefined && !isExternallyManaged(row.service) && row.service.state === 'running';
            const busy = pending?.key === row.key;
            return (
              <Fragment key={row.key}>
                <tr>
                  {group === 'issuer' && <td>{row.kbName}</td>}
                  <th scope="row">
                    {row.service.role}
                    {row.service.product !== undefined && <small>{row.service.product}</small>}
                  </th>
                  <td>{row.service.runsOn ?? '—'}</td>
                  <td>{row.service.containerState === undefined ? row.service.state : `${row.service.state} (${row.service.containerState})`}</td>
                  <td className={row.service.healthy ? 'launcher-status__healthy' : 'launcher-status__unhealthy'}>
                    {row.service.healthy ? 'Answers' : 'Does not answer'}
                    {!row.service.counted && <small>not counted</small>}
                  </td>
                  {group === 'issuer' && <td>{row.service.realm ?? '—'}</td>}
                  {!knowledgeBaseServiceModal && group !== 'issuer' && <td>{row.service.serves?.join(', ') ?? '—'}</td>}
                  <td>
                    {row.service.page !== undefined && <a href={row.service.page} target="_blank" rel="noreferrer">Open</a>}
                    {row.service.page !== undefined && row.service.probe !== undefined && <br />}
                    {row.service.probe !== undefined && <code>{row.service.probe}</code>}
                  </td>
                  <td>
                    {busy ? (
                      <span className="service-group__busy">{pending?.action === 'start' ? 'Starting…' : 'Stopping…'}</span>
                    ) : canStart ? (
                      <button type="button" className="kb__connect" disabled={pending !== null} onClick={() => onOperate(row, 'start')}>Start</button>
                    ) : canStop ? (
                      <button type="button" className="kb__connect kb__connect--on" disabled={pending !== null} onClick={() => onOperate(row, 'stop')}>Stop</button>
                    ) : (
                      <span className="service-group__busy">—</span>
                    )}
                  </td>
                </tr>
                {group === 'gateway-archivist' && row.service.role === 'archivist' && (
                  <tr className="service-group__git-row">
                    <td colSpan={6}><GitStatusSection check={gitCheck} /></td>
                  </tr>
                )}
              </Fragment>
            );
            })}
            {group === 'gateway-archivist' && !rows.some((row) => row.service.role === 'archivist') && (
              <tr className="service-group__git-row">
                <td colSpan={6}><GitStatusSection check={gitCheck} /></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function rowsForGroup(
  snapshot: ControlStatusSnapshotResult,
  group: DesktopServiceGroup,
  selectedRootPath: string | null,
): ServiceRow[] {
  if (isKnowledgeBaseServiceModal(group)) {
    const kb = snapshot.knowledgeBases.find((item) => item.root === selectedRootPath);
    if (kb === undefined) return [];
    const roles: readonly string[] = group === 'gateway-archivist'
      ? ['gateway', 'archivist']
      : ['dispatcher', 'messaging'];
    return kb.services.filter((service) => service.group === 'record' && roles.includes(service.role)).map((service) => {
      const target = targetFor(kb);
      return {
        key: `${kb.key}/${service.role}`,
        kbName: kb.siteName ?? kb.name,
        service,
        ...(target === undefined ? {} : { target }),
      };
    });
  }

  if (group === 'issuer') {
    return snapshot.knowledgeBases.flatMap((kb) => kb.services
      .filter((service) => service.group === group)
      .map((service) => {
        const target = targetFor(kb);
        return {
          key: `${kb.key}/${service.role}`,
          kbName: kb.siteName ?? kb.name,
          service,
          ...(target === undefined ? {} : { target }),
        };
      }));
  }

  if (group === 'browser') {
    return snapshot.shared
      .filter((service) => service.group === 'knowledge-workers' && service.role === 'browser')
      .map((service) => ({
        key: `browser/${service.role}`,
        service,
        ...(selectedRootPath === null ? {} : { target: { kind: 'local' as const, root: selectedRootPath } }),
      }));
  }

  return snapshot.shared
    .filter((service) => service.group === group && (group !== 'knowledge-workers' || service.role !== 'browser'))
    .map((service) => ({
      key: `${group}/${service.role}`,
      service,
      ...(selectedRootPath === null ? {} : { target: { kind: 'local' as const, root: selectedRootPath } }),
    }));
}

function isKnowledgeBaseServiceModal(group: DesktopServiceGroup): group is KnowledgeBaseServiceModal {
  return group === 'gateway-archivist' || group === 'dispatcher-messaging';
}

function targetFor(kb: ControlKnowledgeBaseStatus): ControlTarget | undefined {
  if (kb.placement === 'local' && kb.root !== undefined) return { kind: 'local', root: kb.root };
  if (kb.placement === 'codespace' && kb.repo !== undefined) return { kind: 'codespace', repo: kb.repo };
  return undefined;
}

function isExternallyManaged(service: ControlServiceStatus): boolean {
  return service.runsOn === 'external' || service.state === 'reachable' || service.state === 'unreachable' || service.state === 'not-configured';
}
