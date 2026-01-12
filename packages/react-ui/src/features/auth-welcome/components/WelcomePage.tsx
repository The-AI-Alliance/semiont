/**
 * WelcomePage Component
 *
 * Pure React component for the welcome/terms acceptance page.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';

export interface WelcomePageProps {
  // User data
  userName?: string;
  termsAcceptedAt?: string | null;
  isNewUser?: boolean;

  // State
  status: 'loading' | 'accepted' | 'form';
  isProcessing: boolean;

  // Actions
  onAccept: () => void;
  onDecline: () => void;

  // Translations
  translations: {
    loading: string;
    welcomeTitle: string;
    thanksForAccepting: string;
    welcomeUser: string;
    reviewTermsPrompt: string;
    termsSummaryTitle: string;
    termsSummaryIntro: string;
    acceptableUseTitle: string;
    acceptableUseResponsible: string;
    acceptableUseRespect: string;
    acceptableUseConduct: string;
    prohibitedContentTitle: string;
    prohibitedContentIntro: string;
    prohibitedIllegal: string;
    prohibitedAdult: string;
    prohibitedHate: string;
    prohibitedViolence: string;
    prohibitedMisinformation: string;
    prohibitedPrivacy: string;
    prohibitedCopyright: string;
    prohibitedMalware: string;
    prohibitedSpam: string;
    conductTitle: string;
    conductDescription: string;
    conductLink: string;
    conductPromotion: string;
    responsibilitiesTitle: string;
    responsibilitiesSecure: string;
    responsibilitiesReport: string;
    responsibilitiesAccurate: string;
    responsibilitiesComply: string;
    violationsWarning: string;
    readFullTerms: string;
    termsOfService: string;
    and: string;
    privacyPolicy: string;
    declineAndSignOut: string;
    acceptAndContinue: string;
    processing: string;
    legallyBound: string;
  };

  // Component dependencies
  PageLayout: React.ComponentType<any>;
  Link: React.ComponentType<any>;
}

export function WelcomePage({
  userName,
  status,
  isProcessing,
  onAccept,
  onDecline,
  translations: t,
  PageLayout,
  Link,
}: WelcomePageProps) {
  // Loading state
  if (status === 'loading') {
    return (
      <PageLayout className="semiont-welcome-page__layout">
        <div className="semiont-welcome-page__loading">
          <div className="semiont-welcome-page__loading-content">
            <div className="semiont-welcome-page__spinner"></div>
            <p className="semiont-welcome-page__loading-text">{t.loading}</p>
          </div>
        </div>
      </PageLayout>
    );
  }

  // Accepted state
  if (status === 'accepted') {
    return (
      <PageLayout className="semiont-welcome-page__layout">
        <div className="semiont-welcome-page__accepted">
          <div className="semiont-welcome-page__accepted-content">
            <div className="semiont-welcome-page__accepted-icon">
              <svg className="semiont-welcome-page__accepted-checkmark" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <h2 className="semiont-welcome-page__accepted-title">{t.welcomeTitle}</h2>
              <p className="semiont-welcome-page__accepted-subtitle">
                {t.thanksForAccepting}
              </p>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  // Terms form
  return (
    <PageLayout className="semiont-welcome-page__layout">
      <div className="semiont-welcome-page__form-wrapper">
        <div className="semiont-welcome-page__form">
          <div className="semiont-welcome-page__form-header">
            <div className="semiont-welcome-page__form-icon">
              <svg className="semiont-welcome-page__form-icon-svg" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h1 className="semiont-welcome-page__form-title">
              {t.welcomeUser.replace('{firstName}', userName || '')}
            </h1>
            <p className="semiont-welcome-page__form-subtitle">
              {t.reviewTermsPrompt}
            </p>
          </div>

          <div className="semiont-welcome-page__terms-content">
            <div className="prose dark:prose-invert max-w-none text-sm">
              <h3>{t.termsSummaryTitle}</h3>
              <p>{t.termsSummaryIntro}</p>

              <h4>{t.acceptableUseTitle}</h4>
              <ul>
                <li>{t.acceptableUseResponsible}</li>
                <li>{t.acceptableUseRespect}</li>
                <li>{t.acceptableUseConduct}</li>
              </ul>

              <h4>{t.prohibitedContentTitle}</h4>
              <p>{t.prohibitedContentIntro}</p>
              <ul>
                <li>{t.prohibitedIllegal}</li>
                <li>{t.prohibitedAdult}</li>
                <li>{t.prohibitedHate}</li>
                <li>{t.prohibitedViolence}</li>
                <li>{t.prohibitedMisinformation}</li>
                <li>{t.prohibitedPrivacy}</li>
                <li>{t.prohibitedCopyright}</li>
                <li>{t.prohibitedMalware}</li>
                <li>{t.prohibitedSpam}</li>
              </ul>

              <h4>{t.conductTitle}</h4>
              <p>
                {t.conductDescription}{' '}
                <a
                  href="https://ai-alliance.cdn.prismic.io/ai-alliance/Zl-MG5m069VX1dgH_AIAllianceCodeofConduct.pdf"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {t.conductLink}
                </a>
                {t.conductPromotion}
              </p>

              <h4>{t.responsibilitiesTitle}</h4>
              <ul>
                <li>{t.responsibilitiesSecure}</li>
                <li>{t.responsibilitiesReport}</li>
                <li>{t.responsibilitiesAccurate}</li>
                <li>{t.responsibilitiesComply}</li>
              </ul>

              <p className="mt-4 font-medium">
                {t.violationsWarning}
              </p>
            </div>
          </div>

          <div className="semiont-welcome-page__actions">
            <p className="semiont-welcome-page__legal-links">
              {t.readFullTerms}{' '}
              <Link
                href="/terms"
                target="_blank"
                className="semiont-welcome-page__link"
              >
                {t.termsOfService}
              </Link>
              {' '}{t.and}{' '}
              <Link
                href="/privacy"
                target="_blank"
                className="semiont-welcome-page__link"
              >
                {t.privacyPolicy}
              </Link>
            </p>

            <div className="semiont-welcome-page__buttons">
              <button
                onClick={onDecline}
                disabled={isProcessing}
                className="semiont-welcome-page__button semiont-welcome-page__button--secondary"
              >
                {t.declineAndSignOut}
              </button>
              <button
                onClick={onAccept}
                disabled={isProcessing}
                className="semiont-welcome-page__button semiont-welcome-page__button--primary"
              >
                {isProcessing ? t.processing : t.acceptAndContinue}
              </button>
            </div>

            <p className="semiont-welcome-page__legal-notice">
              {t.legallyBound}
            </p>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
