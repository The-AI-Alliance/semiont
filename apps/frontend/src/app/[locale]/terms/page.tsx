'use client';

import React, { useContext } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { PageLayout } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';

export default function TermsOfService() {
  const t = useTranslations('Terms');
  const tFooter = useTranslations('Footer');
  const tNav = useTranslations('Navigation');
  const tHome = useTranslations('Home');
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
              <Link href={`/${locale}/privacy`} className="semiont-static-link">
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