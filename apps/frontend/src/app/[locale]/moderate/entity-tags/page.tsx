import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Toolbar,
  useTheme,
  useShellVM,
  useObservable,
  useLineNumbers,
  useEventSubscriptions,
  useSemiont,
  useViewModel,
  EntityTagsPage,
} from '@semiont/react-ui';
import { createEntityTagsVM } from '@semiont/api-client';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';

export default function EntityTagsPageWrapper() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`ModerateEntityTags.${k}`, p as any) as string;
  const client = useObservable(useSemiont().activeSession$)?.client;

  const browseVM = useShellVM();
  const vm = useViewModel(() => createEntityTagsVM(client!, browseVM));

  const activePanel = useObservable(vm.browse.activePanel$) ?? null;
  const entityTypes = useObservable(vm.entityTypes$) ?? [];
  const isLoading = useObservable(vm.isLoading$) ?? true;
  const newTag = useObservable(vm.newTag$) ?? '';
  const error = useObservable(vm.error$) ?? '';
  const isAddingTag = useObservable(vm.isAdding$) ?? false;

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
      onNewTagChange={vm.setNewTag}
      onAddTag={vm.addTag}
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
