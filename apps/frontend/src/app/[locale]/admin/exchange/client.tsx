/**
 * Admin Exchange Client - Thin Next.js wrapper
 *
 * Handles Next.js-specific concerns (translations, API calls, hooks)
 * and delegates rendering to the pure React AdminExchangePage component.
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdmin, Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useBrowseVM, useObservable, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { AdminExchangePage } from '@semiont/react-ui';
import type { ImportPreview } from '@semiont/react-ui';

export default function AdminExchangeClient() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AdminExchange.${k}`, p as any) as string;

  // Toolbar and settings state
  const browseVM = useBrowseVM();
  const activePanel = useObservable(browseVM.activePanel$) ?? null;
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
  const adminAPI = useAdmin();
  const backupMutation = adminAPI.exchange.backup.useMutation();
  const restoreMutation = adminAPI.exchange.restore.useMutation();

  // Local state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importPhase, setImportPhase] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | undefined>();
  const [importResult, setImportResult] = useState<Record<string, unknown> | undefined>();

  const handleBackup = useCallback(() => {
    backupMutation.mutate();
  }, [backupMutation]);

  const handleFileSelected = useCallback(async (file: File) => {
    setSelectedFile(file);
    setImportPhase(null);
    setImportMessage(undefined);
    setImportResult(undefined);

    // For tar.gz backups, show basic info
    setPreview({
      format: file.name.endsWith('.tar.gz') || file.name.endsWith('.gz') ? 'semiont-backup' : 'unknown',
      version: 1,
      sourceUrl: '',
      stats: {},
    });
  }, []);

  const handleRestore = useCallback(() => {
    if (!selectedFile) return;

    setImportPhase('started');
    setImportMessage(undefined);
    setImportResult(undefined);

    restoreMutation.mutate({
      file: selectedFile,
      onProgress: (event) => {
        setImportPhase(event.phase);
        setImportMessage(event.message);
        if (event.result) {
          setImportResult(event.result);
        }
      },
    });
  }, [selectedFile, restoreMutation]);

  const handleCancelRestore = useCallback(() => {
    setSelectedFile(null);
    setPreview(null);
    setImportPhase(null);
    setImportMessage(undefined);
    setImportResult(undefined);
  }, []);

  return (
    <AdminExchangePage
      onExport={handleBackup}
      isExporting={backupMutation.isPending}
      onFileSelected={handleFileSelected}
      onImport={handleRestore}
      onCancelImport={handleCancelRestore}
      selectedFile={selectedFile}
      preview={preview}
      isImporting={restoreMutation.isPending}
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
