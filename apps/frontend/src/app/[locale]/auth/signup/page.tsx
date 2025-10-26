'use client';

import React from 'react';
import { signIn } from 'next-auth/react';
import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { PageLayout } from '@/components/PageLayout';
import { buttonStyles } from '@/lib/button-styles';

function SignUpContent() {
  const t = useTranslations('AuthSignUp');
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const callbackUrl = searchParams?.get('callbackUrl') || '/auth/welcome';

  const handleGoogleSignUp = async () => {
    setIsLoading(true);
    try {
      // Use OAuth flow with signup context - new users will be redirected to welcome/terms
      await signIn('google', { 
        callbackUrl: callbackUrl
      });
    } catch (error) {
      console.error('Failed to initiate Google sign-up:', error);
      setIsLoading(false);
    }
  };

  return (
    <PageLayout className="bg-gray-50 dark:bg-gray-900" showAuthLinks={false}>
      <div className="flex items-center justify-center py-12 font-sans">
        <div className="max-w-md w-full space-y-8">
          <div>
            <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">
              {t('pageTitle')}
            </h2>
            <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
              {t('signUpPrompt')}
            </p>
          </div>

          <div className="mt-8 space-y-6">
            <button
              onClick={handleGoogleSignUp}
              disabled={isLoading}
              className={buttonStyles.primary.large}
            >
            {isLoading ? (
              <div className="w-5 h-5 mr-2 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
            ) : (
              <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            )}
            {isLoading ? t('creatingAccount') : t('signUpWithGoogle')}
          </button>

          <div className="text-xs text-center text-gray-500 dark:text-gray-400">
            {t('approvedDomainsInfo')}<br/>
            {t('termsAgreement')}
          </div>

          <div className="text-center">
            <Link
              href="/auth/signin"
              className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
            >
              {t('alreadyHaveAccount')}
            </Link>
          </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

function LoadingFallback() {
  const t = useTranslations('AuthSignUp');
  return <div>{t('loading')}</div>;
}

export default function SignUp() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <SignUpContent />
    </Suspense>
  );
}