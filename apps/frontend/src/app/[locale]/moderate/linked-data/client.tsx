import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Toolbar,
  useTheme,
  useBrowseVM,
  useObservable,
  useLineNumbers,
  useEventSubscriptions,
  useApiClient,
  useAuthToken,
  useViewModel,
  LinkedDataPage,
} from '@semiont/react-ui';
import { createExchangeVM } from '@semiont/api-client';
import { accessToken } from '@semiont/core';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';

export default function LinkedDataClient() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`ModerationLinkedData.${k}`, p as any) as string;
  const client = useApiClient();
  const token = useAuthToken();

  const browseVM = useBrowseVM();
  const vm = useViewModel(() => createExchangeVM(
    browseVM,
    (params, opts) => client.exportKnowledgeBase(params, opts),
    (file, opts) => client.importKnowledgeBase(file, opts),
  ));

  const activePanel = useObservable(vm.browse.activePanel$) ?? null;
  const selectedFile = useObservable(vm.selectedFile$) ?? null;
  const preview = useObservable(vm.preview$) ?? null;
  const isExporting = useObservable(vm.isExporting$) ?? false;
  const isImporting = useObservable(vm.isImporting$) ?? false;
  const importPhase = useObservable(vm.importPhase$) ?? null;
  const importMessage = useObservable(vm.importMessage$);
  const importResult = useObservable(vm.importResult$);

  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  useEventSubscriptions({
    'settings:theme-changed': useCallback(({ theme }: { theme: 'light' | 'dark' | 'system' }) => setTheme(theme), [setTheme]),
    'settings:line-numbers-toggled': useCallback(() => toggleLineNumbers(), [toggleLineNumbers]),
  });

  const auth = token ? accessToken(token) : undefined;

  const handleExport = useCallback(async () => {
    if (!auth) return;
    const { blob, filename } = await vm.doExport(auth);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [vm, auth]);

  const handleImport = useCallback(async () => {
    if (!auth) return;
    await vm.doImport(auth);
  }, [vm, auth]);

  return (
    <LinkedDataPage
      onExport={handleExport}
      isExporting={isExporting}
      onFileSelected={vm.selectFile}
      onImport={handleImport}
      onCancelImport={vm.cancelImport}
      selectedFile={selectedFile}
      preview={preview}
      isImporting={isImporting}
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
