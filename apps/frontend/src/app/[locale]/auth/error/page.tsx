'use client';

import React, { useContext, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PageLayout, AuthErrorDisplay } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';
import Link from 'next/link';

/**
 * AuthErrorContent - Thin Next.js wrapper for AuthErrorDisplay
 *
 * Reads searchParams and translations, passes as props to pure component.
 */
function AuthErrorContent() {
  const t = useTranslations('AuthError');
  const tFooter = useTranslations('Footer');
  const tNav = useTranslations('Navigation');
  const tHome = useTranslations('Home');
  const searchParams = useSearchParams();
  const keyboardContext = useContext(KeyboardShortcutsContext);

  const errorType = searchParams?.get('error') ?? null;

  const translations = {
    pageTitle: t('pageTitle'),
    tryAgain: t('tryAgain'),
    errorConfiguration: t('errorConfiguration'),
    errorAccessDenied: t('errorAccessDenied'),
    errorVerification: t('errorVerification'),
    errorGeneric: t('errorGeneric'),
  };

  return (
    <PageLayout
      Link={RoutingLink}
      routes={routes}
      t={tFooter}
      tNav={tNav}
      tHome={tHome}
      CookiePreferences={CookiePreferences}
      {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      className="bg-gray-50 dark:bg-gray-900"
    >
      <AuthErrorDisplay errorType={errorType} Link={Link} translations={translations} />
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