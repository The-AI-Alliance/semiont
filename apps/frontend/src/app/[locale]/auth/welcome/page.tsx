'use client';

import React from 'react';
import { useSession } from 'next-auth/react';
import { useState, useEffect } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { PageLayout } from '@/components/PageLayout';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/lib/api-hooks';

export default function Welcome() {
  const t = useTranslations('AuthWelcome');
  const { data: session, status } = useSession();
  const router = useRouter();
  const [termsAccepted, setTermsAccepted] = useState(false);
  const { showError } = useToast();

  // API hooks
  const authAPI = useAuth();

  // Query user data to check if terms already accepted
  const { data: userData } = authAPI.me.useQuery();

  // Mutation for accepting terms
  const acceptTermsMutation = authAPI.acceptTerms.useMutation();

  // Redirect if not authenticated or if terms already accepted
  useEffect(() => {
    if (status === 'loading') return; // Still loading
    if (status === 'unauthenticated') {
      router.push('/auth/signin');
      return;
    }

    // Check if user has accepted terms
    if (userData?.termsAcceptedAt) {
      router.push('/');
      return;
    }

    // If not a new user, redirect to main app (existing users don't need to accept terms again)
    if (session && !session.isNewUser) {
      router.push('/');
      return;
    }
  }, [status, session, router, userData]);

  const handleTermsAcceptance = async (accepted: boolean) => {
    if (!accepted) {
      // User declined terms - sign them out and redirect to home
      const { signOut } = await import('next-auth/react');
      await signOut({ callbackUrl: '/' });
      return;
    }

    try {
      await acceptTermsMutation.mutateAsync();
      setTermsAccepted(true);

      // Small delay to show the acceptance state
      setTimeout(() => {
        router.push('/');
      }, 1000);
    } catch (error) {
      console.error('Terms acceptance error:', error);
      showError(t('errorAcceptingTerms'));
    }
  };

  // Show loading while session is being fetched
  if (status === 'loading') {
    return (
      <PageLayout className="bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="w-8 h-8 mx-auto animate-spin rounded-full border-2 border-blue-600 border-t-transparent"></div>
            <p className="mt-2 text-gray-600 dark:text-gray-400">{t('loading')}</p>
          </div>
        </div>
      </PageLayout>
    );
  }

  // Show terms accepted confirmation
  if (termsAccepted) {
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
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{t('welcomeTitle')}</h2>
              <p className="mt-2 text-gray-600 dark:text-gray-400">
                {t('thanksForAccepting')}
              </p>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  // Show terms acceptance form
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
              {t('welcomeUser', { firstName: session?.user?.name?.split(' ')[0] ?? '' })}
            </h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              {t('reviewTermsPrompt')}
            </p>
          </div>

          <div className="max-h-96 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-6 mb-6 bg-gray-50 dark:bg-gray-900">
            <div className="prose dark:prose-invert max-w-none text-sm">
              <h3>{t('termsSummaryTitle')}</h3>
              <p>{t('termsSummaryIntro')}</p>

              <h4>{t('acceptableUseTitle')}</h4>
              <ul>
                <li>{t('acceptableUseResponsible')}</li>
                <li>{t('acceptableUseRespect')}</li>
                <li>{t('acceptableUseConduct')}</li>
              </ul>

              <h4>{t('prohibitedContentTitle')}</h4>
              <p>{t('prohibitedContentIntro')}</p>
              <ul>
                <li>{t('prohibitedIllegal')}</li>
                <li>{t('prohibitedAdult')}</li>
                <li>{t('prohibitedHate')}</li>
                <li>{t('prohibitedViolence')}</li>
                <li>{t('prohibitedMisinformation')}</li>
                <li>{t('prohibitedPrivacy')}</li>
                <li>{t('prohibitedCopyright')}</li>
                <li>{t('prohibitedMalware')}</li>
                <li>{t('prohibitedSpam')}</li>
              </ul>

              <h4>{t('conductTitle')}</h4>
              <p>
                {t('conductDescription')}{' '}
                <a
                  href="https://ai-alliance.cdn.prismic.io/ai-alliance/Zl-MG5m069VX1dgH_AIAllianceCodeofConduct.pdf"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {t('conductLink')}
                </a>
                {t('conductPromotion')}
              </p>

              <h4>{t('responsibilitiesTitle')}</h4>
              <ul>
                <li>{t('responsibilitiesSecure')}</li>
                <li>{t('responsibilitiesReport')}</li>
                <li>{t('responsibilitiesAccurate')}</li>
                <li>{t('responsibilitiesComply')}</li>
              </ul>

              <p className="mt-4 font-medium">
                {t('violationsWarning')}
              </p>
            </div>
          </div>

          <div className="text-center space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('readFullTerms')}{' '}
              <Link
                href="/terms"
                target="_blank"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('termsOfService')}
              </Link>
              {' '}{t('and')}{' '}
              <Link
                href="/privacy"
                target="_blank"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('privacyPolicy')}
              </Link>
            </p>

            <div className="flex justify-center gap-4">
              <button
                onClick={() => handleTermsAcceptance(false)}
                disabled={acceptTermsMutation.isPending}
                className="px-6 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                {t('declineAndSignOut')}
              </button>
              <button
                onClick={() => handleTermsAcceptance(true)}
                disabled={acceptTermsMutation.isPending}
                className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                {acceptTermsMutation.isPending ? t('processing') : t('acceptAndContinue')}
              </button>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('legallyBound')}
            </p>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}