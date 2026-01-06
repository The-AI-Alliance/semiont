'use client';

import React, { useEffect, useState, Suspense, useContext } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Footer, SignInForm } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';
import Link from 'next/link';

/**
 * SignInContent - Thin Next.js wrapper for SignInForm
 *
 * This component:
 * - Reads Next.js-specific hooks (useSearchParams, useTranslations)
 * - Manages error state from URL params
 * - Checks for credential provider availability
 * - Passes data as props to the pure SignInForm component
 */
function SignInContent() {
  const t = useTranslations('AuthSignIn');
  const tFooter = useTranslations('Footer');
  const searchParams = useSearchParams();
  const keyboardContext = useContext(KeyboardShortcutsContext);

  const [error, setError] = useState<string | null>(null);
  const [showLocalAuth, setShowLocalAuth] = useState(false);

  const callbackUrl = searchParams?.get('callbackUrl') || '/know';

  useEffect(() => {
    // Check if credentials provider is available
    fetch('/api/auth/providers')
      .then((res) => res.json())
      .then((providers) => {
        if (providers.credentials) {
          setShowLocalAuth(true);
        }
      })
      .catch(() => {});

    // Parse error from URL
    const errorParam = searchParams?.get('error');
    if (errorParam) {
      switch (errorParam) {
        case 'Signin':
          setError(t('errorAuthFailed'));
          break;
        case 'OAuthSignin':
          setError(t('errorGoogleConnect'));
          break;
        case 'OAuthCallback':
          setError(t('errorDomainNotAllowed'));
          break;
        case 'OAuthCreateAccount':
          setError(t('errorCreateAccount'));
          break;
        default:
          setError(t('errorGeneric'));
      }
    }
  }, [searchParams, t]);

  const handleGoogleSignIn = async () => {
    try {
      await signIn('google', { callbackUrl });
    } catch (error) {
      setError(t('errorGoogleSignIn'));
    }
  };

  const handleLocalSignIn = async (email: string, password: string) => {
    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
        callbackUrl,
      });

      if (result?.error) {
        setError(t('errorInvalidCredentials'));
      } else if (result?.ok) {
        window.location.href = callbackUrl;
      }
    } catch (error) {
      setError(t('errorSignInFailed'));
    }
  };

  const translations = {
    pageTitle: t('pageTitle'),
    welcomeBack: t('welcomeBack'),
    signInPrompt: t('signInPrompt'),
    continueWithGoogle: t('continueWithGoogle'),
    emailLabel: t('emailLabel'),
    emailPlaceholder: t('emailPlaceholder'),
    passwordLabel: t('passwordLabel'),
    passwordPlaceholder: t('passwordPlaceholder'),
    signInLocal: t('signInLocal'),
    or: t('or'),
    localAuthEnabled: t('localAuthEnabled'),
    approvedDomainsOnly: t('approvedDomainsOnly'),
    backToHome: t('backToHome'),
    learnMore: t('learnMore'),
    signUpInstead: t('signUpInstead'),
    errorEmailRequired: t('errorEmailRequired'),
    errorPasswordRequired: t('errorPasswordRequired'),
  };

  return (
    <div className="flex flex-col min-h-screen">
      <SignInForm
        onGoogleSignIn={handleGoogleSignIn}
        onLocalSignIn={showLocalAuth ? handleLocalSignIn : undefined}
        error={error}
        showLocalAuth={showLocalAuth}
        Link={Link}
        translations={translations}
      />

      <Footer
        Link={RoutingLink}
        routes={routes}
        t={tFooter}
        CookiePreferences={CookiePreferences}
        {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      />
    </div>
  );
}

function LoadingFallback() {
  const t = useTranslations('AuthSignIn');
  return <div>{t('loading')}</div>;
}

export default function SignIn() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <SignInContent />
    </Suspense>
  );
}
