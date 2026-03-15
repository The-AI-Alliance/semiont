/**
 * LinkedDataPage — JSON-LD Export/Import moderation page
 *
 * Pure React component. All state and handlers passed as props.
 * Reuses ExportCard, ImportCard, and ImportProgress from admin-exchange.
 */

import React from 'react';
import { COMMON_PANELS, type ToolbarPanelType } from '../../../hooks/usePanelBrowse';
import { ExportCard, type ExportCardTranslations } from '../../admin-exchange/components/ExportCard';
import { ImportCard, type ImportCardProps, type ImportCardTranslations } from '../../admin-exchange/components/ImportCard';
import { ImportProgress, type ImportProgressTranslations } from '../../admin-exchange/components/ImportProgress';

export interface LinkedDataPageTranslations {
  title: string;
  subtitle: string;
  export: ExportCardTranslations;
  import: ImportCardTranslations;
  progress: ImportProgressTranslations;
}

export interface LinkedDataPageProps {
  // Export
  onExport: () => void;
  isExporting: boolean;

  // Import
  onFileSelected: (file: File) => void;
  onImport: () => void;
  onCancelImport: () => void;
  selectedFile: File | null;
  preview: ImportCardProps['preview'];
  isImporting: boolean;

  // Progress
  importPhase: string | null;
  importMessage?: string | undefined;
  importResult?: Record<string, unknown> | undefined;

  // UI state
  theme: 'light' | 'dark' | 'system';
  showLineNumbers: boolean;
  activePanel: string | null;

  // Translations
  translations: LinkedDataPageTranslations;

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export function LinkedDataPage({
  onExport,
  isExporting,
  onFileSelected,
  onImport,
  onCancelImport,
  selectedFile,
  preview,
  isImporting,
  importPhase,
  importMessage,
  importResult,
  theme,
  showLineNumbers,
  activePanel,
  translations: t,
  ToolbarPanels,
  Toolbar,
}: LinkedDataPageProps) {
  return (
    <div className={`semiont-page${activePanel && COMMON_PANELS.includes(activePanel as ToolbarPanelType) ? ' semiont-page--panel-open' : ''}`}>
      <div className="semiont-page__content">
        <div className="semiont-page__header">
          <h1 className="semiont-page__title">{t.title}</h1>
          <p className="semiont-page__subtitle">{t.subtitle}</p>
        </div>

        <div className="semiont-exchange__cards">
          <ExportCard
            onExport={onExport}
            isExporting={isExporting}
            translations={t.export}
          />

          <ImportCard
            onFileSelected={onFileSelected}
            onImport={onImport}
            onCancel={onCancelImport}
            selectedFile={selectedFile}
            preview={preview}
            isImporting={isImporting}
            translations={t.import}
          />
        </div>

        {importPhase && (
          <ImportProgress
            phase={importPhase}
            message={importMessage}
            result={importResult}
            translations={t.progress}
          />
        )}
      </div>

      <div className="semiont-page__sidebar">
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          showLineNumbers={showLineNumbers}
        />
        <Toolbar
          context="simple"
          activePanel={activePanel}
        />
      </div>
    </div>
  );
}
