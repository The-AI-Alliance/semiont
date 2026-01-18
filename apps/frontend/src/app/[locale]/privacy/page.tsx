'use client';

import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { PageLayout } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';

export default function PrivacyPolicyPage() {
  const t = useTranslations('Privacy');
  const tFooter = useTranslations('Footer');
  const tNav = useTranslations('Navigation');
  const tHome = useTranslations('Home');
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
            <h1 className="semiont-static-title">{t('pageTitle')}</h1>
          </header>

          <article className="semiont-static-article">
            <section>
              <h2>{t('introTitle')}</h2>
              {t('intro').split('\n\n').map((para, i) => (
                <p key={i}>
                  {para}
                </p>
              ))}
            </section>

            <section>
              <h2>{t('infoCollectTitle')}</h2>

              <h3>{t('personalInfoTitle')}</h3>
              <ul>
                {t('personalInfo').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>

              <h3>{t('autoCollectTitle')}</h3>
              <ul>
                {t('autoCollect').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>

            <section>
              <h2>{t('howWeUseTitle')}</h2>
              <ul>
                {t('howWeUse').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>

            <section>
              <h2>{t('cookiePolicyTitle')}</h2>
              <p>
                {t('cookiePolicyIntro')}
              </p>

              <h3>{t('cookieCategoriesTitle')}</h3>

              <div className="semiont-static-cookie-grid">
                <div className="semiont-static-cookie-card">
                  <h4>{t('necessaryCookiesTitle')}</h4>
                  {t('necessaryCookies').split('\n\n').map((para, i) => (
                    <p key={i}>
                      {para}
                    </p>
                  ))}
                </div>

                <div className="semiont-static-cookie-card">
                  <h4>{t('analyticsCookiesTitle')}</h4>
                  {t('analyticsCookies').split('\n\n').map((para, i) => (
                    <p key={i}>
                      {para}
                    </p>
                  ))}
                </div>

                <div className="semiont-static-cookie-card">
                  <h4>{t('marketingCookiesTitle')}</h4>
                  {t('marketingCookies').split('\n\n').map((para, i) => (
                    <p key={i}>
                      {para}
                    </p>
                  ))}
                </div>

                <div className="semiont-static-cookie-card">
                  <h4>{t('preferenceCookiesTitle')}</h4>
                  {t('preferenceCookies').split('\n\n').map((para, i) => (
                    <p key={i}>
                      {para}
                    </p>
                  ))}
                </div>
              </div>
            </section>

            <section>
              <h2>{t('yourRightsTitle')}</h2>

              <h3>{t('gdprRightsTitle')}</h3>
              <ul>
                {t('gdprRights').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>

              <h3>{t('ccpaRightsTitle')}</h3>
              <ul>
                {t('ccpaRights').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>

            <section>
              <h2>{t('dataSecurityTitle')}</h2>
              {t('dataSecurity').split('\n\n').map((block, i) => {
                if (i === 0) {
                  return (
                    <p key={i}>
                      {block}
                    </p>
                  );
                }
                return (
                  <ul key={i}>
                    {block.split('\n').map((item, j) => (
                      <li key={j}>{item}</li>
                    ))}
                  </ul>
                );
              })}
            </section>

            <section>
              <h2>{t('dataRetentionTitle')}</h2>
              <p>
                {t('dataRetention')}
              </p>
            </section>

            <section>
              <h2>{t('internationalTransfersTitle')}</h2>
              <p>
                {t('internationalTransfers')}
              </p>
            </section>

            <section>
              <h2>{t('contactTitle')}</h2>
              <p>
                {t('contactIntro')}
              </p>
              <div className="semiont-static-info-box">
                <p>
                  <strong>{t('contactEmail')}</strong> privacy@semiont.com<br />
                  <strong>{t('contactAddress')}</strong> [Your Company Address]
                </p>
              </div>
            </section>

            <section>
              <h2>{t('updatesTitle')}</h2>
              <p>
                {t('updates')}
              </p>
              <footer className="semiont-static-footer">
                <p>
                  <strong>{t('lastUpdated', { date: new Date().toLocaleDateString() })}</strong>
                </p>
              </footer>
            </section>
          </article>
        </div>
      </div>
    </PageLayout>
  );
}