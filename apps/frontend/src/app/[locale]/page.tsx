import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { Link } from '@/i18n/routing';
import { Footer, SemiontBranding, buttonStyles } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';

export default function Home() {
  const { isAuthenticated, isLoading } = useAuth();
  const status = isLoading ? 'loading' : isAuthenticated ? 'authenticated' : 'unauthenticated';
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Home.${k}`, p as any) as string;
  const tFooter = (k: string, p?: Record<string, unknown>) => _t(`Footer.${k}`, p as any) as string;
  const keyboardContext = useContext(KeyboardShortcutsContext);

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 flex flex-col items-center justify-center p-24" role="main">
        <div className="z-10 max-w-5xl text-sm">
          {status === 'loading' ? (
            <div className="text-center">
              <p className="text-gray-600 dark:text-gray-300">{t('loading')}</p>
            </div>
          ) : (
            <div className="text-center space-y-8">
              <section aria-labelledby="hero-heading" className="py-8">
                <h1 id="hero-heading" className="sr-only">Semiont - AI-Powered Research Platform</h1>
                <SemiontBranding
                  t={t}
                  size="xl"
                  animated={true}
                  className="mb-8"
                />
                <p className="text-xl text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
                  {t('description')}
                </p>
              </section>

              <div className="flex gap-4 justify-center items-center flex-wrap">
                {isAuthenticated ? (
                  <>
                    <Link to="/know" className={buttonStyles.primary.base}>
                      {t('continueToKnowledgeBase')}
                    </Link>
                    <Link to="/about" className={buttonStyles.secondary.base}>
                      {t('learnMore')}
                    </Link>
                  </>
                ) : (
                  <Link to="/auth/connect?callbackUrl=/know" className={buttonStyles.primary.base}>
                    {t('signIn')}
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>
      </main>

      <Footer
        Link={RoutingLink}
        routes={routes}
        t={tFooter}
        CookiePreferences={CookiePreferences}
        showPolicyLinks={!('__TAURI_INTERNALS__' in window)}
        {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      />
    </div>
  );
}
