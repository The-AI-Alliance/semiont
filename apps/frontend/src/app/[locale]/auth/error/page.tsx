import { useContext } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout, AuthErrorDisplay } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';
import { Link } from '@/i18n/routing';

export default function AuthError() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AuthError.${k}`, p as any) as string;
  const tFooter = (k: string, p?: Record<string, unknown>) => _t(`Footer.${k}`, p as any) as string;
  const tNav = (k: string, p?: Record<string, unknown>) => _t(`Navigation.${k}`, p as any) as string;
  const tHome = (k: string, p?: Record<string, unknown>) => _t(`Home.${k}`, p as any) as string;
  const [searchParams] = useSearchParams();
  const keyboardContext = useContext(KeyboardShortcutsContext);

  const errorType = searchParams.get('error') ?? null;

  const translations = {
    pageTitle: t('pageTitle'),
    tryAgain: t('tryAgain'),
    errorConfiguration: t('errorConfiguration'),
    errorAccessDenied: t('errorAccessDenied'),
    errorVerification: t('errorVerification'),
    errorGeneric: t('errorGeneric'),
  };

  return (
    <PageLayout
      Link={RoutingLink}
      routes={routes}
      t={tFooter}
      tNav={tNav}
      tHome={tHome}
      CookiePreferences={CookiePreferences}
      {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      className="bg-gray-50 dark:bg-gray-900"
    >
      <AuthErrorDisplay errorType={errorType} Link={Link} translations={translations} />
    </PageLayout>
  );
}
