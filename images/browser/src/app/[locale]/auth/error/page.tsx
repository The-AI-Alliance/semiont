import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageLayout, AuthErrorDisplay } from '@semiont/react-ui';
import { Link, routes } from '@/lib/routing';

export default function AuthError() {
  const { t } = useTranslation(undefined, { keyPrefix: 'AuthError' });
  const { t: tNav } = useTranslation(undefined, { keyPrefix: 'Navigation' });
  const { t: tHome } = useTranslation(undefined, { keyPrefix: 'Home' });
  const [searchParams] = useSearchParams();

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
      Link={Link}
      routes={routes}
      tNav={tNav}
      tHome={tHome}
      className="bg-gray-50 dark:bg-gray-900"
    >
      <AuthErrorDisplay errorType={errorType} Link={Link} translations={translations} />
    </PageLayout>
  );
}
