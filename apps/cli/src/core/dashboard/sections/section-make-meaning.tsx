import React from 'react';
import type { MakeMeaningStatus, ActorStatus, ServiceStatus } from '../dashboard-components.js';
import { MmRow, MmGroup, SectionInference } from './dashboard-shared.js';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function truncatePath(p: string, max = 40): string {
  if (p.length <= max) return p;
  return '…' + p.slice(p.length - max + 1);
}

function actorIndicatorClass(actor: ActorStatus): string {
  switch (actor.state) {
    case 'active':  return 'semiont-indicator semiont-indicator--online semiont-indicator--pulse';
    case 'idle':    return 'semiont-indicator semiont-indicator--online';
    case 'error':   return 'semiont-indicator semiont-indicator--offline';
    default:        return 'semiont-indicator';
  }
}

function graphIndicatorClass(status: MakeMeaningStatus['graph']['status']): string {
  switch (status) {
    case 'healthy':   return 'semiont-indicator semiont-indicator--online';
    case 'unhealthy': return 'semiont-indicator semiont-indicator--offline';
    default:          return 'semiont-indicator';
  }
}

interface Props {
  makeMeaning: MakeMeaningStatus;
  inferenceServices: ServiceStatus[];
}

export const SectionMakeMeaning: React.FC<Props> = ({ makeMeaning: mm, inferenceServices }) => {
  return (
    <div className="mm-sections">

      <MmGroup title="System of Record">
        <MmRow
          indicator="semiont-indicator semiont-indicator--online"
          label="Event Log"
          value={mm.eventLog.eventCount !== undefined
            ? mm.eventLog.eventCount.toLocaleString() + ' events'
            : 'unknown'}
          tags={[
            mm.eventLog.streamCount !== undefined && `${mm.eventLog.streamCount} streams`,
            mm.eventLog.sizeBytes !== undefined && formatBytes(mm.eventLog.sizeBytes),
            mm.eventLog.path && truncatePath(mm.eventLog.path),
          ]}
        />
        <MmRow
          indicator="semiont-indicator semiont-indicator--online"
          label="Content Store"
          value={mm.contentStore.sizeBytes !== undefined
            ? formatBytes(mm.contentStore.sizeBytes)
            : 'unknown'}
          tags={[
            mm.contentStore.fileCount !== undefined && `${mm.contentStore.fileCount} files`,
            mm.contentStore.path && truncatePath(mm.contentStore.path),
          ]}
        />
      </MmGroup>

      <MmGroup title="Projections">
        <MmRow
          indicator={graphIndicatorClass(mm.graph.status)}
          label="Graph"
          value={mm.graph.status}
          tags={[
            mm.graph.address,
            mm.graph.database,
            ...(mm.graph.evidence ?? []),
          ]}
        />
        <MmRow
          indicator="semiont-indicator semiont-indicator--online"
          label="Materialized Views"
          value={mm.materializedViews.fileCount !== undefined
            ? `${mm.materializedViews.fileCount} projections`
            : 'unknown'}
          tags={[
            mm.materializedViews.lastUpdated &&
              `updated ${new Date(mm.materializedViews.lastUpdated).toLocaleTimeString()}`,
            mm.materializedViews.path && truncatePath(mm.materializedViews.path),
          ]}
        />
      </MmGroup>

      <MmGroup title="Actors">
        {(['gatherer', 'matcher', 'stower', 'browser'] as const).map(name => {
          const actor = mm.actors[name];
          return (
            <MmRow
              key={name}
              indicator={actorIndicatorClass(actor)}
              label={name.charAt(0).toUpperCase() + name.slice(1)}
              value={actor.state}
              tags={[
                actor.provider,
                actor.model,
                actor.errorMessage && actor.errorMessage.slice(0, 40),
              ]}
            />
          );
        })}
      </MmGroup>

      <SectionInference inferenceServices={inferenceServices} />

    </div>
  );
};
