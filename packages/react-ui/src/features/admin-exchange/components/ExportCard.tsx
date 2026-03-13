/**
 * ExportCard — Format selection and export trigger
 *
 * Pure React component. All state and handlers passed as props.
 */

import { useState } from 'react';

export interface ExportCardTranslations {
  title: string;
  description: string;
  formatLabel: string;
  formatBackup: string;
  formatSnapshot: string;
  includeArchived: string;
  exportButton: string;
  exporting: string;
}

export interface ExportCardProps {
  onExport: (format: 'backup' | 'snapshot', includeArchived: boolean) => void;
  isExporting: boolean;
  translations: ExportCardTranslations;
}

export function ExportCard({ onExport, isExporting, translations: t }: ExportCardProps) {
  const [format, setFormat] = useState<'backup' | 'snapshot'>('backup');
  const [includeArchived, setIncludeArchived] = useState(false);

  return (
    <div className="semiont-admin__card">
      <h2 className="semiont-admin__section-title">{t.title}</h2>
      <p className="semiont-admin__section-description">{t.description}</p>

      <div className="semiont-exchange__field">
        <label className="semiont-exchange__label" htmlFor="export-format">
          {t.formatLabel}
        </label>
        <select
          id="export-format"
          className="semiont-select"
          value={format}
          onChange={(e) => setFormat(e.target.value as 'backup' | 'snapshot')}
          disabled={isExporting}
        >
          <option value="backup">{t.formatBackup}</option>
          <option value="snapshot">{t.formatSnapshot}</option>
        </select>
      </div>

      {format === 'snapshot' && (
        <div className="semiont-exchange__field">
          <label className="semiont-exchange__checkbox-label">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              disabled={isExporting}
            />
            {t.includeArchived}
          </label>
        </div>
      )}

      <button
        className="semiont-exchange__button semiont-exchange__button--primary"
        onClick={() => onExport(format, includeArchived)}
        disabled={isExporting}
      >
        {isExporting ? t.exporting : t.exportButton}
      </button>
    </div>
  );
}
