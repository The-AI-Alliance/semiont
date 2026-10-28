import { useTranslation } from 'react-i18next';
import { Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useShellStateUnit, useObservable } from '@semiont/react-ui';
import { RecentDocumentsPage } from '@semiont/react-ui';

export default function RecentDocumentsPageWrapper() {
  const { t } = useTranslation(undefined, { keyPrefix: 'ModerateRecent' });

  // Toolbar and settings state
  const browseStateUnit = useShellStateUnit();
  const activePanel = useObservable(browseStateUnit.activePanel$) ?? null;
  const { theme } = useTheme();



  return (
    <RecentDocumentsPage
      isLoading={false}
      theme={theme}
      activePanel={activePanel}
      translations={{
        pageTitle: t('pageTitle'),
        pageDescription: t('pageDescription'),
        sectionTitle: t('sectionTitle'),
        sectionDescription: t('sectionDescription'),
        noDocuments: t('noDocuments'),
        activityWillAppear: t('activityWillAppear'),
        loading: t('loading'),
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
