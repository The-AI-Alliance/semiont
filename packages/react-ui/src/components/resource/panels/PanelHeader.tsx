'use client';

interface PanelHeaderProps {
  count: number;
  title: string;
}

/**
 * Shared header for annotation panels
 *
 * Displays the translated title and the count in a consistent format
 */
export function PanelHeader({ count, title }: PanelHeaderProps) {
  return (
    <div className="semiont-panel-header">
      <h2 className="semiont-panel-header__title">
        <span className="semiont-panel-header__text">{title}</span>
        <span className="semiont-panel-header__count">({count})</span>
      </h2>
    </div>
  );
}
