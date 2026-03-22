import React from 'react';
import { SectionHeader } from './section-header.js';
import type { MakeMeaningStatus, ActorStatus } from '../dashboard-components.js';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function truncatePath(p: string, max = 32): string {
  if (p.length <= max) return p;
  return '…' + p.slice(p.length - max + 1);
}

function actorIndicatorClass(actor: ActorStatus): string {
  switch (actor.state) {
    case 'active':  return 'semiont-indicator semiont-indicator--pulse';
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

function countHealthy(mm: MakeMeaningStatus): number {
  let n = 0;
  if (mm.eventLog.path) n++;
  if (mm.contentStore.path) n++;
  if (mm.graph.status === 'healthy') n++;
  if (mm.materializedViews.path) n++;
  if (mm.actors.gatherer.state !== 'error' && mm.actors.gatherer.state !== 'unknown') n++;
  if (mm.actors.matcher.state !== 'error' && mm.actors.matcher.state !== 'unknown') n++;
  if (mm.actors.stower.state !== 'error' && mm.actors.stower.state !== 'unknown') n++;
  return n;
}

interface Props {
  makeMeaning: MakeMeaningStatus;
}

export const SectionMakeMeaning: React.FC<Props> = ({ makeMeaning: mm }) => {
  const healthyCount = countHealthy(mm);

  return (
    <SectionHeader title="Make Meaning" healthyCount={healthyCount} totalCount={7}>
      <div className="stat-card-grid">

        {/* Event Log */}
        <div className="semiont-stat-card">
          <span className="semiont-indicator semiont-indicator--online" />
          <div className="semiont-stat-card__label">Event Log</div>
          <div className="semiont-stat-card__value">
            {mm.eventLog.eventCount !== undefined
              ? mm.eventLog.eventCount.toLocaleString() + ' events'
              : 'unknown'}
          </div>
          <div className="semiont-stat-card__meta">
            {mm.eventLog.streamCount !== undefined &&
              <span className="semiont-tag">{mm.eventLog.streamCount} streams</span>}
            {mm.eventLog.sizeBytes !== undefined &&
              <span className="semiont-tag">{formatBytes(mm.eventLog.sizeBytes)}</span>}
            {mm.eventLog.path &&
              <span className="semiont-tag">{truncatePath(mm.eventLog.path)}</span>}
          </div>
        </div>

        {/* Content Store */}
        <div className="semiont-stat-card">
          <span className="semiont-indicator semiont-indicator--online" />
          <div className="semiont-stat-card__label">Content Store</div>
          <div className="semiont-stat-card__value">
            {mm.contentStore.sizeBytes !== undefined
              ? formatBytes(mm.contentStore.sizeBytes)
              : 'unknown'}
          </div>
          <div className="semiont-stat-card__meta">
            {mm.contentStore.fileCount !== undefined &&
              <span className="semiont-tag">{mm.contentStore.fileCount} files</span>}
            {mm.contentStore.path &&
              <span className="semiont-tag">{truncatePath(mm.contentStore.path)}</span>}
          </div>
        </div>

        {/* Graph */}
        <div className="semiont-stat-card">
          <span className={graphIndicatorClass(mm.graph.status)} />
          <div className="semiont-stat-card__label">Graph</div>
          <div className="semiont-stat-card__value">{mm.graph.status}</div>
          <div className="semiont-stat-card__meta">
            {mm.graph.address && <span className="semiont-tag">{mm.graph.address}</span>}
            {mm.graph.database && <span className="semiont-tag">{mm.graph.database}</span>}
          </div>
        </div>

        {/* Materialized Views */}
        <div className="semiont-stat-card">
          <span className="semiont-indicator semiont-indicator--online" />
          <div className="semiont-stat-card__label">Mat. Views</div>
          <div className="semiont-stat-card__value">
            {mm.materializedViews.fileCount !== undefined
              ? `${mm.materializedViews.fileCount} projections`
              : 'unknown'}
          </div>
          <div className="semiont-stat-card__meta">
            {mm.materializedViews.lastUpdated &&
              <span className="semiont-tag">
                updated {new Date(mm.materializedViews.lastUpdated).toLocaleTimeString()}
              </span>}
            {mm.materializedViews.path &&
              <span className="semiont-tag">{truncatePath(mm.materializedViews.path)}</span>}
          </div>
        </div>

        {/* Actors */}
        {(['gatherer', 'matcher', 'stower'] as const).map(name => {
          const actor = mm.actors[name];
          return (
            <div key={name} className="semiont-stat-card">
              <span className={actorIndicatorClass(actor)} />
              <div className="semiont-stat-card__label">
                {name.charAt(0).toUpperCase() + name.slice(1)}
              </div>
              <div className="semiont-stat-card__value">{actor.state}</div>
              <div className="semiont-stat-card__meta">
                {actor.model && <span className="semiont-tag">{actor.model}</span>}
                {actor.errorMessage && (
                  <span className="semiont-tag semiont-tag--error">{actor.errorMessage.slice(0, 30)}</span>
                )}
              </div>
            </div>
          );
        })}

      </div>
    </SectionHeader>
  );
};
