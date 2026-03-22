import React, { useState } from 'react';

interface SectionHeaderProps {
  title: string;
  healthyCount: number;
  totalCount: number;
  children: React.ReactNode;
}

function badgeVariant(healthy: number, total: number): string {
  if (total === 0) return 'semiont-badge semiont-badge--info';
  if (healthy === total) return 'semiont-badge semiont-badge--success';
  if (healthy === 0) return 'semiont-badge semiont-badge--error';
  return 'semiont-badge semiont-badge--warning';
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({ title, healthyCount, totalCount, children }) => {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="semiont-panel semiont-panel--bordered dashboard-section">
      <div className="semiont-panel-header dashboard-section-header" onClick={() => setCollapsed(c => !c)}>
        <button className="collapse-toggle" aria-label={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▶' : '▼'}
        </button>
        <span className="semiont-panel-header__title">{title}</span>
        <span className={badgeVariant(healthyCount, totalCount)}>
          {healthyCount}/{totalCount} healthy
        </span>
      </div>
      {!collapsed && (
        <div className="dashboard-section-body">
          {children}
        </div>
      )}
    </div>
  );
};
