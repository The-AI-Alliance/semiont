'use client';

import React from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Suspense } from 'react';
import { PageLayout } from '@/components/PageLayout';

function AuthErrorContent() {
  const t = useTranslations('AuthError');
  const searchParams = useSearchParams();
  const error = searchParams?.get('error') ?? null;

  const getErrorMessage = (error: string | null) => {
    switch (error) {
      case 'Configuration':
        return t('errorConfiguration');
      case 'AccessDenied':
        return t('errorAccessDenied');
      case 'Verification':
        return t('errorVerification');
      default:
        return t('errorGeneric');
    }
  };

  return (
    <PageLayout className="bg-gray-50 dark:bg-gray-900">
      <div className="flex items-center justify-center py-20">
        <div className="max-w-md w-full space-y-8">
          <div>
            <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">
              {t('pageTitle')}
            </h2>
          </div>

          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4">
            <div className="text-sm text-red-700 dark:text-red-400">
              {getErrorMessage(error)}
            </div>
          </div>

          <div className="text-center">
            <Link
              href="/auth/signin"
              className="text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {t('tryAgain')}
            </Link>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

function LoadingFallback() {
  const t = useTranslations('AuthError');
  return <div>{t('loading')}</div>;
}

export default function AuthError() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <AuthErrorContent />
    </Suspense>
  );
}