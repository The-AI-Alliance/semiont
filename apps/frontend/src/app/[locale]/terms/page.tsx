import React, { useContext } from 'react';
import { Link } from '@/i18n/routing';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/i18n/routing';
import { PageLayout } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';

export default function TermsOfService() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Terms.${k}`, p as any) as string;
  const { t: _tFooter } = useTranslation();
  const tFooter = (k: string, p?: Record<string, unknown>) => _tFooter(`Footer.${k}`, p as any) as string;
  const { t: _tNav } = useTranslation();
  const tNav = (k: string, p?: Record<string, unknown>) => _tNav(`Navigation.${k}`, p as any) as string;
  const { t: _tHome } = useTranslation();
  const tHome = (k: string, p?: Record<string, unknown>) => _tHome(`Home.${k}`, p as any) as string;
  const locale = useLocale();
  const keyboardContext = useContext(KeyboardShortcutsContext);

  return (
    <PageLayout
      Link={RoutingLink}
      routes={routes}
      t={tFooter}
      tNav={tNav}
      tHome={tHome}
      CookiePreferences={CookiePreferences}
      {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      className="semiont-static-page"
    >
      <div className="semiont-static-container">
        <div className="semiont-static-content">
          <header className="semiont-static-header">
            <h1 className="semiont-static-title">
              {t('pageTitle')}
            </h1>
            <p className="semiont-static-subtitle">
              {t('pageSubtitle')}
            </p>
          </header>

          <article className="semiont-static-article">
            <h2>{t('aupTitle')}</h2>

            <p>
              {t('aup')}
            </p>

            <h3>{t('prohibitedTitle')}</h3>
            <p>{t('prohibitedIntro')}</p>
            <ul>
              {t('prohibited').split('\n').map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>

            <h3>{t('aiAllianceTitle')}</h3>
            <p>
              {t('aiAllianceIntro')}{' '}
              <a
                href="https://ai-alliance.cdn.prismic.io/ai-alliance/Zl-MG5m069VX1dgH_AIAllianceCodeofConduct.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="semiont-static-link"
              >
                {t('aiAllianceLink')}
              </a>
              {t('aiAllianceIncludes')}
            </p>
            <ul>
              {t('aiAlliance').split('\n').map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>

            <h3>{t('responsibilitiesTitle')}</h3>
            <p>{t('responsibilitiesIntro')}</p>
            <ul>
              {t('responsibilities').split('\n').map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>

            <h3>{t('moderationTitle')}</h3>
            <p>
              {t('moderation')}
            </p>

            <h3>{t('privacyTitle')}</h3>
            <p>
              {t('privacy').split(t('privacyLink'))[0]}
              <Link to={`/${locale}/privacy`} className="semiont-static-link">
                {t('privacyLink')}
              </Link>
              {t('privacy').split(t('privacyLink'))[1]}
            </p>

            <h3>{t('ipTitle')}</h3>
            <p>
              {t('ip')}
            </p>

            <h3>{t('liabilityTitle')}</h3>
            <p>
              {t('liability')}
            </p>

            <h3>{t('changesTitle')}</h3>
            <p>
              {t('changes')}
            </p>

            <h3>{t('contactTitle')}</h3>
            <p>
              {t('contact')}
            </p>

            <footer className="semiont-static-footer">
              <p>
                {t('lastUpdated', { date: new Date().toLocaleDateString() })}
              </p>
            </footer>
          </article>

        </div>
      </div>
    </PageLayout>
  );
}