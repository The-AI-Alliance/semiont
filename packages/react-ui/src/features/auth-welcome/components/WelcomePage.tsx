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
      <PageLayout className="bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="w-8 h-8 mx-auto animate-spin rounded-full border-2 border-blue-600 border-t-transparent"></div>
            <p className="mt-2 text-gray-600 dark:text-gray-400">{t.loading}</p>
          </div>
        </div>
      </PageLayout>
    );
  }

  // Accepted state
  if (status === 'accepted') {
    return (
      <PageLayout className="bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-center py-20">
          <div className="max-w-md w-full text-center space-y-6">
            <div className="w-16 h-16 mx-auto bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{t.welcomeTitle}</h2>
              <p className="mt-2 text-gray-600 dark:text-gray-400">
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
    <PageLayout className="bg-gray-50 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <div className="bg-white dark:bg-gray-800 shadow-lg rounded-lg p-8">
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              {t.welcomeUser.replace('{firstName}', userName || '')}
            </h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              {t.reviewTermsPrompt}
            </p>
          </div>

          <div className="max-h-96 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-6 mb-6 bg-gray-50 dark:bg-gray-900">
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

          <div className="text-center space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t.readFullTerms}{' '}
              <Link
                href="/terms"
                target="_blank"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t.termsOfService}
              </Link>
              {' '}{t.and}{' '}
              <Link
                href="/privacy"
                target="_blank"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t.privacyPolicy}
              </Link>
            </p>

            <div className="flex justify-center gap-4">
              <button
                onClick={onDecline}
                disabled={isProcessing}
                className="px-6 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                {t.declineAndSignOut}
              </button>
              <button
                onClick={onAccept}
                disabled={isProcessing}
                className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                {isProcessing ? t.processing : t.acceptAndContinue}
              </button>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t.legallyBound}
            </p>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
