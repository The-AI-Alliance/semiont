import React from 'react';
import { SectionHeader } from './section-header.js';
import type { WorkerStatus } from '../dashboard-components.js';

const WORKER_LABELS: Record<WorkerStatus['type'], string> = {
  'reference-annotation':  'Reference Ann.',
  'highlight-annotation':  'Highlight Ann.',
  'assessment-annotation': 'Assessment Ann.',
  'comment-annotation':    'Comment Ann.',
  'tag-annotation':        'Tag Ann.',
  'generation':            'Generation',
};

function workerIndicatorClass(w: WorkerStatus): string {
  if (w.state === 'error') return 'semiont-indicator semiont-indicator--offline';
  if (w.activeCount > 0)   return 'semiont-indicator semiont-indicator--pulse';
  if (w.pendingCount > 10) return 'semiont-indicator semiont-indicator--warning';
  return 'semiont-indicator semiont-indicator--online';
}

function activeTagClass(w: WorkerStatus): string {
  if (w.activeCount > 0) return 'semiont-tag semiont-tag--success';
  return 'semiont-tag';
}

interface Props {
  workers: WorkerStatus[];
}

export const SectionWorkers: React.FC<Props> = ({ workers }) => {
  const activeCount = workers.filter(w => w.activeCount > 0).length;

  return (
    <SectionHeader title="Job Workers" healthyCount={activeCount} totalCount={workers.length}>
      <div className="stat-card-grid">
        {workers.map((w, i) => (
          <div key={i} className="semiont-stat-card">
            <span className={workerIndicatorClass(w)} />
            <div className="semiont-stat-card__label">{WORKER_LABELS[w.type]}</div>
            <div className="semiont-stat-card__value">
              {w.pendingCount} pending
            </div>
            <div className="semiont-stat-card__meta">
              <span className={activeTagClass(w)}>{w.activeCount} active</span>
              {w.lastProcessed && (
                <span className="semiont-tag">
                  last: {new Date(w.lastProcessed).toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </SectionHeader>
  );
};
