import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Toolbar,
  useTheme,
  useShellStateUnit,
  useObservable,
  useLineNumbers,
  useEventSubscriptions,
  useSemiont,
  useStateUnit,
  AdminExchangePage,
} from '@semiont/react-ui';
import { createExchangeStateUnit } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';

export default function AdminExchangeClient() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AdminExchange.${k}`, p as any) as string;
  const client = useObservable(useSemiont().activeSession$)?.client;

  const browseStateUnit = useShellStateUnit();
  const stateUnit = useStateUnit(() => createExchangeStateUnit(
    browseStateUnit,
    () => client!.admin!.backup(),
    (file) => client!.admin!.restore(file),
  ));

  const activePanel = useObservable(stateUnit.browse.activePanel$) ?? null;
  const selectedFile = useObservable(stateUnit.selectedFile$) ?? null;
  const preview = useObservable(stateUnit.preview$) ?? null;
  const isExporting = useObservable(stateUnit.isExporting$) ?? false;
  const isImporting = useObservable(stateUnit.isImporting$) ?? false;
  const importPhase = useObservable(stateUnit.importPhase$) ?? null;
  const importMessage = useObservable(stateUnit.importMessage$);
  const importResult = useObservable(stateUnit.importResult$);

  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  useEventSubscriptions({
    'settings:theme-changed': useCallback(({ theme }: { theme: 'light' | 'dark' | 'system' }) => setTheme(theme), [setTheme]),
    'settings:line-numbers-toggled': useCallback(() => toggleLineNumbers(), [toggleLineNumbers]),
  });

  const handleExport = useCallback(async () => {
    const { blob, filename } = await stateUnit.doExport();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [stateUnit]);

  const handleImport = useCallback(async () => {
    await stateUnit.doImport();
  }, [stateUnit]);

  return (
    <AdminExchangePage
      onExport={handleExport}
      isExporting={isExporting}
      onFileSelected={stateUnit.selectFile}
      onImport={handleImport}
      onCancelImport={stateUnit.cancelImport}
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
