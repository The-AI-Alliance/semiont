/**
 * Linked Data Client - Thin Next.js wrapper
 *
 * Handles Next.js-specific concerns (translations, API calls, hooks)
 * and delegates rendering to the pure React LinkedDataPage component.
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useModeration, Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, usePanelBrowse, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { LinkedDataPage } from '@semiont/react-ui';
import type { ImportPreview } from '@semiont/react-ui';

export default function LinkedDataClient() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`ModerationLinkedData.${k}`, p as any) as string;

  // Toolbar and settings state
  const { activePanel } = usePanelBrowse();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const handleThemeChanged = useCallback(({ theme }: { theme: 'light' | 'dark' | 'system' }) => {
    setTheme(theme);
  }, [setTheme]);

  const handleLineNumbersToggled = useCallback(() => {
    toggleLineNumbers();
  }, [toggleLineNumbers]);

  useEventSubscriptions({
    'settings:theme-changed': handleThemeChanged,
    'settings:line-numbers-toggled': handleLineNumbersToggled,
  });

  // API hooks
  const moderationAPI = useModeration();
  const exportMutation = moderationAPI.exchange.export.useMutation();
  const importMutation = moderationAPI.exchange.import.useMutation();

  // Local state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importPhase, setImportPhase] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | undefined>();
  const [importResult, setImportResult] = useState<Record<string, unknown> | undefined>();

  const handleExport = useCallback(() => {
    exportMutation.mutate({});
  }, [exportMutation]);

  const handleFileSelected = useCallback(async (file: File) => {
    setSelectedFile(file);
    setImportPhase(null);
    setImportMessage(undefined);
    setImportResult(undefined);

    setPreview({
      format: file.name.endsWith('.tar.gz') || file.name.endsWith('.gz') ? 'semiont-linked-data' : 'unknown',
      version: 1,
      sourceUrl: '',
      stats: {},
    });
  }, []);

  const handleImport = useCallback(() => {
    if (!selectedFile) return;

    setImportPhase('started');
    setImportMessage(undefined);
    setImportResult(undefined);

    importMutation.mutate({
      file: selectedFile,
      onProgress: (event) => {
        setImportPhase(event.phase);
        setImportMessage(event.message);
        if (event.result) {
          setImportResult(event.result);
        }
      },
    });
  }, [selectedFile, importMutation]);

  const handleCancelImport = useCallback(() => {
    setSelectedFile(null);
    setPreview(null);
    setImportPhase(null);
    setImportMessage(undefined);
    setImportResult(undefined);
  }, []);

  return (
    <LinkedDataPage
      onExport={handleExport}
      isExporting={exportMutation.isPending}
      onFileSelected={handleFileSelected}
      onImport={handleImport}
      onCancelImport={handleCancelImport}
      selectedFile={selectedFile}
      preview={preview}
      isImporting={importMutation.isPending}
      importPhase={importPhase}
      importMessage={importMessage}
      importResult={importResult}
      theme={theme}
      showLineNumbers={showLineNumbers}
      activePanel={activePanel}
      translations={{
        title: t('title'),
        subtitle: t('subtitle'),
        export: {
          title: t('exportTitle'),
          description: t('exportDescription'),
          exportButton: t('exportButton'),
          exporting: t('exporting'),
        },
        import: {
          title: t('importTitle'),
          description: t('importDescription'),
          dropzoneLabel: t('dropzoneLabel'),
          dropzoneActive: t('dropzoneActive'),
          detectedFormat: t('detectedFormat'),
          statsPreview: t('statsPreview'),
          importButton: t('importButton'),
          importing: t('importing'),
          importConfirmTitle: t('importConfirmTitle'),
          importConfirmMessage: t('importConfirmMessage'),
          confirmImport: t('confirmImport'),
          cancelImport: t('cancelImport'),
        },
        progress: {
          phaseStarted: t('phaseStarted'),
          phaseEntityTypes: t('phaseEntityTypes'),
          phaseResources: t('phaseResources'),
          phaseAnnotations: t('phaseAnnotations'),
          phaseComplete: t('phaseComplete'),
          phaseError: t('phaseError'),
          hashChainValid: t('hashChainValid'),
          hashChainInvalid: t('hashChainInvalid'),
          streams: t('streams'),
          events: t('events'),
          blobs: t('blobs'),
        },
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
