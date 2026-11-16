/**
 * ExportCard — Backup trigger
 *
 * Pure React component. All state and handlers passed as props.
 */

export interface ExportCardTranslations {
  title: string;
  description: string;
  exportButton: string;
  exporting: string;
}

export interface ExportCardProps {
  onExport: () => void;
  isExporting: boolean;
  translations: ExportCardTranslations;
}

export function ExportCard({ onExport, isExporting, translations: t }: ExportCardProps) {
  return (
    <div className="semiont-admin__card">
      <h2 className="semiont-admin__section-title">{t.title}</h2>
      <p className="semiont-admin__section-description">{t.description}</p>

      <button
        className="semiont-exchange__button semiont-exchange__button--primary"
        onClick={onExport}
        disabled={isExporting}
      >
        {isExporting ? t.exporting : t.exportButton}
      </button>
    </div>
  );
}
