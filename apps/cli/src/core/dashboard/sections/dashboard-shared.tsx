import React from 'react';
import type { ServiceStatus } from '../dashboard-components.js';

const TAG = 'semiont-tag semiont-tag--secondary semiont-tag--compact';

export const MmRow: React.FC<{
  indicator: string;
  label: string;
  value: string;
  tags?: (string | undefined | false)[];
}> = ({ indicator, label, value, tags }) => (
  <div className="mm-row">
    <div className="mm-row__indicator"><span className={indicator} /></div>
    <div className="mm-row__label">{label}</div>
    <div className="mm-row__value">{value}</div>
    <div className="mm-row__tags">
      {tags?.filter(Boolean).map((t, i) => (
        <span key={i} className={TAG}>{t as string}</span>
      ))}
    </div>
  </div>
);

export const MmGroup: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="mm-group">
    <div className="mm-group__title">{title}</div>
    <div className="mm-list">{children}</div>
  </div>
);

export function inferenceIndicatorClass(status: ServiceStatus['status']): string {
  switch (status) {
    case 'healthy':   return 'semiont-indicator semiont-indicator--online';
    case 'unhealthy': return 'semiont-indicator semiont-indicator--offline';
    default:          return 'semiont-indicator';
  }
}

export function inferenceServiceLabel(name: string): string {
  // "inference.anthropic" → "Anthropic"
  return name.includes('.')
    ? name.slice(name.indexOf('.') + 1).replace(/^\w/, c => c.toUpperCase())
    : name;
}

export const SectionInference: React.FC<{ inferenceServices: ServiceStatus[] }> = ({ inferenceServices }) => {
  if (inferenceServices.length === 0) return null;
  return (
    <MmGroup title="Inference">
      {inferenceServices.map(svc => (
        <MmRow
          key={svc.name}
          indicator={inferenceIndicatorClass(svc.status)}
          label={inferenceServiceLabel(svc.name)}
          value={svc.status}
          tags={svc.evidence}
        />
      ))}
    </MmGroup>
  );
};
