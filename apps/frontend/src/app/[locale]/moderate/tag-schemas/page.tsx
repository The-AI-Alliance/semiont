import { useMemo } from 'react';
import { isReady } from '@semiont/sdk';
import { useTranslation } from 'react-i18next';
import { Toolbar } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useShellStateUnit, useObservable, useSemiont } from '@semiont/react-ui';
import { TagSchemasPage } from '@semiont/react-ui';

// Authentication is handled by middleware (proxy.ts)
// Only authenticated moderators/admins can reach this page

export default function TagSchemasPageWrapper() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`ModerateTagSchemas.${k}`, p as any) as string;

  // Toolbar and settings state
  const browseStateUnit = useShellStateUnit();
  const activePanel = useObservable(browseStateUnit.activePanel$) ?? null;
  const { theme } = useTheme();



  // Subscribe to the per-KB tag-schema registry. Schemas are runtime-
  // registered by the KB at session start (frame.addTagSchema). The
  // observable yields `undefined` during the initial fetch — surfaced as
  // `isLoading` to the page component.
  const session = useObservable(useSemiont().activeSession$);
  const tagSchemas$ = useMemo(
    () => session?.client.browse.tagSchemas() ?? null,
    [session],
  );
  const schemasObserved = useObservable(tagSchemas$);
  // D1 unwrap: the third outcome is explicit — a failed registry read shows
  // as not-loading with an empty list here (failure UI is follow-up work).
  const schemas = schemasObserved && isReady(schemasObserved) ? schemasObserved.value : [];
  const isLoading = schemasObserved === undefined || schemasObserved.status === 'pending';

  return (
    <TagSchemasPage
      schemas={schemas}
      isLoading={isLoading}
      theme={theme}
      activePanel={activePanel}
      translations={{
        pageTitle: t('pageTitle'),
        pageDescription: t('pageDescription'),
        categories: t('categories'),
        loading: t('loading'),
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
    />
  );
}
