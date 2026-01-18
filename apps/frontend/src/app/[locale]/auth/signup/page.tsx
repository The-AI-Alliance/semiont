'use client';

import React, { useContext, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PageLayout, SignUpForm } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';
import Link from 'next/link';

/**
 * SignUpContent - Thin Next.js wrapper for SignUpForm
 *
 * This component:
 * - Reads Next.js-specific hooks (useSearchParams, useTranslations)
 * - Passes data as props to the pure SignUpForm component
 * - Wraps in PageLayout
 *
 * The actual form logic is in features/auth/components/SignUpForm.tsx
 */
function SignUpContent() {
  const t = useTranslations('AuthSignUp');
  const tFooter = useTranslations('Footer');
  const tNav = useTranslations('Navigation');
  const tHome = useTranslations('Home');
  const searchParams = useSearchParams();
  const keyboardContext = useContext(KeyboardShortcutsContext);

  const callbackUrl = searchParams?.get('callbackUrl') || '/auth/welcome';

  const handleSignUp = async () => {
    await signIn('google', { callbackUrl });
  };

  const translations = {
    pageTitle: t('pageTitle'),
    signUpPrompt: t('signUpPrompt'),
    signUpWithGoogle: t('signUpWithGoogle'),
    creatingAccount: t('creatingAccount'),
    approvedDomainsInfo: t('approvedDomainsInfo'),
    termsAgreement: t('termsAgreement'),
    alreadyHaveAccount: t('alreadyHaveAccount'),
    tagline: tHome('tagline'),
    backToHome: t('backToHome'),
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
      className="semiont-page-layout--auth"
      showAuthLinks={false}
    >
      <SignUpForm onSignUp={handleSignUp} Link={Link} translations={translations} />
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
