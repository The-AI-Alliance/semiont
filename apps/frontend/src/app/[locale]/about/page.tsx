import React, { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { PageLayout, buttonStyles } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';
import { Link } from '@/i18n/routing';

export default function AboutPage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`About.${k}`, p as any) as string;
  const { t: _tFooter } = useTranslation();
  const tFooter = (k: string, p?: Record<string, unknown>) => _tFooter(`Footer.${k}`, p as any) as string;
  const { t: _tNav } = useTranslation();
  const tNav = (k: string, p?: Record<string, unknown>) => _tNav(`Navigation.${k}`, p as any) as string;
  const { t: _tHome } = useTranslation();
  const tHome = (k: string, p?: Record<string, unknown>) => _tHome(`Home.${k}`, p as any) as string;
  const keyboardContext = useContext(KeyboardShortcutsContext);

  return (
    <PageLayout
      Link={RoutingLink}
      routes={routes}
      t={tFooter}
      tNav={tNav}
      tHome={tHome}
      showAuthLinks={false}
      CookiePreferences={CookiePreferences}
      {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      className="semiont-static-page"
    >
      <div className="semiont-static-container">
        <div className="semiont-static-content">
          {/* Header */}
          <header className="semiont-static-header">
            <h1 className="semiont-static-title">
              {t('pageTitle')}
            </h1>
            <p className="semiont-static-subtitle">
              {t('tagline')}
            </p>
          </header>

          {/* Action Buttons */}
          <div className="semiont-static-action-buttons">
            <Link
              to="/auth/signup"
              className={buttonStyles.primary.base}
            >
              {t('signUp')}
            </Link>
            <Link
              to="/auth/signin?callbackUrl=/know"
              className={buttonStyles.primary.base}
            >
              {t('signIn')}
            </Link>
          </div>

          <article className="semiont-static-article">
            {/* Mission Section */}
            <section>
              <h2>{t('missionTitle')}</h2>
              <p>
                {t('mission')}
              </p>
            </section>

            {/* Features Section */}
            <section>
              <h2>{t('coreFeaturesTitle')}</h2>

              <div className="semiont-static-feature-grid">
                {/* Semantic Content */}
                <div className="semiont-static-feature-card">
                  <span className="semiont-static-feature-icon">📊</span>
                  <h3>{t('semanticContentTitle')}</h3>
                  <p className="semiont-static-feature-subtitle">
                    {t('semanticContentSubtitle')}
                  </p>
                  {t('semanticContent').split('\n\n').map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                  <span className="semiont-static-badge semiont-static-badge-planned">
                    {t('planned')}
                  </span>
                </div>

                {/* Real-time Collaboration */}
                <div className="semiont-static-feature-card">
                  <span className="semiont-static-feature-icon">🤝</span>
                  <h3>{t('collaborationTitle')}</h3>
                  <p className="semiont-static-feature-subtitle">
                    {t('collaborationSubtitle')}
                  </p>
                  {t('collaboration').split('\n\n').map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                  <span className="semiont-static-badge semiont-static-badge-planned">
                    {t('planned')}
                  </span>
                </div>

                {/* Advanced RBAC */}
                <div className="semiont-static-feature-card">
                  <span className="semiont-static-feature-icon">🔐</span>
                  <h3>{t('rbacTitle')}</h3>
                  <p className="semiont-static-feature-subtitle">
                    {t('rbacSubtitle')}
                  </p>
                  {t('rbac').split('\n\n').map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                  <span className="semiont-static-badge semiont-static-badge-planned">
                    {t('planned')}
                  </span>
                </div>
              </div>
            </section>

            {/* Open Source Section */}
            <section className="semiont-static-highlight">
              <h2>{t('openSourceTitle')}</h2>
              <p>
                {t('openSource')}
              </p>
              <div className="semiont-static-action-buttons">
                <a
                  href="https://github.com/The-AI-Alliance/semiont"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonStyles.secondary.base}
                >
                  {t('viewOnGitHub')}
                </a>
              </div>
            </section>

            {/* Future Vision */}
            <section>
              <h2>{t('futureVisionTitle')}</h2>
              <p>
                {t('futureVision')}
              </p>
            </section>
          </article>
        </div>
      </div>
    </PageLayout>
  );
}