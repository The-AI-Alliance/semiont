'use client';

import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { PageLayout, buttonStyles } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';
import Link from 'next/link';
import { signIn } from 'next-auth/react';

export default function AboutPage() {
  const t = useTranslations('About');
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
              href="/auth/signup"
              className={buttonStyles.primary.base}
            >
              {t('signUp')}
            </Link>
            <button
              onClick={() => signIn(undefined, { callbackUrl: '/know' })}
              className={buttonStyles.primary.base}
              type="button"
            >
              {t('signIn')}
            </button>
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