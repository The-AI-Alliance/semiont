import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Toolbar,
  useTheme,
  useShellStateUnit,
  useObservable,
  useSemiont,
  useSessionStateUnit,
  LinkedDataPage,
} from '@semiont/react-ui';
import { createExchangeStateUnit } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';

export default function LinkedDataClient() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`ModerationLinkedData.${k}`, p as any) as string;
  const session = useObservable(useSemiont().activeSession$) ?? undefined;

  const browseStateUnit = useShellStateUnit();
  const stateUnit = useSessionStateUnit(session, (s) => createExchangeStateUnit(
    browseStateUnit,
    // The callbacks capture the session the unit was BUILT for — a KB switch
    // rebuilds the unit instead of leaving closures over a disposed client.
    (params) => s.client.admin!.exportKnowledgeBase(params),
    (file) => s.client.admin!.importKnowledgeBase(file),
  ));

  const activePanel = useObservable(stateUnit?.browse.activePanel$) ?? null;
  const selectedFile = useObservable(stateUnit?.selectedFile$) ?? null;
  const preview = useObservable(stateUnit?.preview$) ?? null;
  const isExporting = useObservable(stateUnit?.isExporting$) ?? false;
  const isImporting = useObservable(stateUnit?.isImporting$) ?? false;
  const importPhase = useObservable(stateUnit?.importPhase$) ?? null;
  const importMessage = useObservable(stateUnit?.importMessage$);
  const importResult = useObservable(stateUnit?.importResult$);

  const { theme } = useTheme();

  const handleExport = useCallback(async () => {
    if (!stateUnit) return;
    const { blob, filename } = await stateUnit.doExport();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [stateUnit]);

  const handleImport = useCallback(async () => {
    await stateUnit?.doImport();
  }, [stateUnit]);

  if (!stateUnit) return null;

  return (
    <LinkedDataPage
      onExport={handleExport}
      isExporting={isExporting}
      onFileSelected={stateUnit?.selectFile}
      onImport={handleImport}
      onCancelImport={stateUnit?.cancelImport}
      selectedFile={selectedFile}
      preview={preview}
      isImporting={isImporting}
      importPhase={importPhase}
      importMessage={importMessage}
      importResult={importResult}
      theme={theme}
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
          phaseComplete: t('phaseComplete'),
          phaseError: t('phaseError'),
          statsEventsReplayed: t('statsEventsReplayed'),
          statsResourcesCreated: t('statsResourcesCreated'),
          statsAnnotationsCreated: t('statsAnnotationsCreated'),
          statsEntityTypesAdded: t('statsEntityTypesAdded'),
        },
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
