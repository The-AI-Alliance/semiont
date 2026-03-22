import React from 'react';
import type { WorkerStatus } from '../dashboard-components.js';

const TAG_SEC = 'semiont-tag semiont-tag--secondary semiont-tag--compact';

const WORKER_LABELS: Record<WorkerStatus['type'], string> = {
  'reference-annotation':  'Reference Annotation',
  'highlight-annotation':  'Highlight Annotation',
  'assessment-annotation': 'Assessment Annotation',
  'comment-annotation':    'Comment Annotation',
  'tag-annotation':        'Tag Annotation',
  'generation':            'Generation',
};

function workerIndicatorClass(w: WorkerStatus): string {
  if (w.state === 'error') return 'semiont-indicator semiont-indicator--offline';
  if (w.activeCount > 0)   return 'semiont-indicator semiont-indicator--online semiont-indicator--pulse';
  if (w.pendingCount > 10) return 'semiont-indicator semiont-indicator--busy';
  return 'semiont-indicator semiont-indicator--online';
}

interface Props {
  workers: WorkerStatus[];
}

export const SectionWorkers: React.FC<Props> = ({ workers }) => {
  return (
    <div className="mm-list">
      <div className="mm-row mm-row--header">
        <div className="mm-row__indicator" />
        <div className="mm-row__label">Worker</div>
        <div className="mm-row__value">Status</div>
        <div className="mm-row__tags">Details</div>
      </div>
      {workers.map((w, i) => (
        <div key={i} className="mm-row">
          <div className="mm-row__indicator"><span className={workerIndicatorClass(w)} /></div>
          <div className="mm-row__label">{WORKER_LABELS[w.type]}</div>
          <div className="mm-row__value">{w.state}</div>
          <div className="mm-row__tags">
            <span className={w.activeCount > 0 ? 'semiont-tag semiont-tag--success semiont-tag--compact' : TAG_SEC}>
              {w.activeCount} active
            </span>
            <span className={TAG_SEC}>{w.pendingCount} pending</span>
            {w.lastProcessed && (
              <span className={TAG_SEC}>last {new Date(w.lastProcessed).toLocaleTimeString()}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
