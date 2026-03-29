import { useContext } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/i18n/routing';
import { PageLayout, SignUpForm } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';
import { Link } from '@/i18n/routing';

function SignUpContent() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AuthSignUp.${k}`, p as any) as string;
  const tFooter = (k: string, p?: Record<string, unknown>) => _t(`Footer.${k}`, p as any) as string;
  const tNav = (k: string, p?: Record<string, unknown>) => _t(`Navigation.${k}`, p as any) as string;
  const tHome = (k: string, p?: Record<string, unknown>) => _t(`Home.${k}`, p as any) as string;
  const [searchParams] = useSearchParams();
  const router = useRouter();
  const keyboardContext = useContext(KeyboardShortcutsContext);

  const callbackUrl = searchParams.get('callbackUrl') ?? '/auth/welcome';

  const handleSignUp = async () => {
    router.push(`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  };

  const translations = {
    pageTitle: t('pageTitle'),
    signUpPrompt: t('signUpPrompt'),
    signUpWithGoogle: t('signUpWithGoogle'),
    creatingAccount: t('creatingAccount'),
    approvedDomainsInfo: t('approvedDomainsInfo'),
    termsAgreement: t('termsAgreement'),
    alreadyHaveAccount: t('alreadyHaveAccount'),
    tagline: tHome('tagline'),
    backToHome: t('backToHome'),
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
      className="semiont-page-layout--auth"
      showAuthLinks={false}
    >
      <SignUpForm onSignUp={handleSignUp} Link={Link} translations={translations} />
    </PageLayout>
  );
}

export default function SignUp() {
  return <SignUpContent />;
}
