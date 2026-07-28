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
  EntityTagsPage,
} from '@semiont/react-ui';
import { createEntityTagsStateUnit } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';

export default function EntityTagsPageWrapper() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`ModerateEntityTags.${k}`, p as any) as string;
  const client = useObservable(useSemiont().activeSession$)?.client;

  const browseStateUnit = useShellStateUnit();
  const stateUnit = useStateUnit(() => createEntityTagsStateUnit(client!, browseStateUnit));

  const activePanel = useObservable(stateUnit.browse.activePanel$) ?? null;
  const entityTypes = useObservable(stateUnit.entityTypes.value$) ?? [];
  const isLoading = useObservable(stateUnit.entityTypes.loading$) ?? true;
  // A terminally failed load is not still loading. Distinct from `error`
  // below, which is the ADD-tag error. See .plans/PANEL-FAILURE-STATES.md
  const loadError = useObservable(stateUnit.entityTypes.error$) ?? null;
  const newTag = useObservable(stateUnit.newTag$) ?? '';
  const error = useObservable(stateUnit.error$) ?? '';
  const isAddingTag = useObservable(stateUnit.isAdding$) ?? false;

  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  useEventSubscriptions({
    'settings:theme-changed': useCallback(({ theme }: { theme: 'light' | 'dark' | 'system' }) => setTheme(theme), [setTheme]),
    'settings:line-numbers-toggled': useCallback(() => toggleLineNumbers(), [toggleLineNumbers]),
  });

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20">
        <p className="text-gray-600 dark:text-gray-300">{t('loadFailed')}</p>
        <button type="button" onClick={stateUnit.entityTypes.retry} className="semiont-button" data-variant="secondary">
          {t('retry')}
        </button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">{t('loading')}</p>
      </div>
    );
  }

  return (
    <EntityTagsPage
      entityTypes={entityTypes}
      isLoading={isLoading}
      error={error}
      newTag={newTag}
      onNewTagChange={stateUnit.setNewTag}
      onAddTag={stateUnit.addTag}
      isAddingTag={isAddingTag}
      theme={theme}
      showLineNumbers={showLineNumbers}
      activePanel={activePanel}
      translations={{
        pageTitle: t('pageTitle'),
        pageDescription: t('pageDescription'),
        sectionTitle: t('sectionTitle'),
        sectionDescription: t('sectionDescription'),
        inputPlaceholder: t('inputPlaceholder'),
        addTag: t('addTag'),
        adding: t('adding'),
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
