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
  const entityTypes = useObservable(stateUnit.entityTypes$) ?? [];
  const isLoading = useObservable(stateUnit.isLoading$) ?? true;
  const newTag = useObservable(stateUnit.newTag$) ?? '';
  const error = useObservable(stateUnit.error$) ?? '';
  const isAddingTag = useObservable(stateUnit.isAdding$) ?? false;

  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  useEventSubscriptions({
    'settings:theme-changed': useCallback(({ theme }: { theme: 'light' | 'dark' | 'system' }) => setTheme(theme), [setTheme]),
    'settings:line-numbers-toggled': useCallback(() => toggleLineNumbers(), [toggleLineNumbers]),
  });

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
