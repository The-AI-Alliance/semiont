'use client';

import React, { useEffect, useState, Suspense, useContext, useRef, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { Footer, SignInForm } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';
import Link from 'next/link';
import { useAuthContext } from '@/contexts/AuthContext';
import { SemiontApiClient } from '@semiont/api-client';
import { googleCredential, email as makeEmail, baseUrl } from '@semiont/core';
import { NEXT_PUBLIC_BACKEND_URL, NEXT_PUBLIC_GOOGLE_CLIENT_ID } from '@/lib/env';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (response: { credential: string }) => void }) => void;
          prompt: () => void;
        };
      };
    };
  }
}

/**
 * SignInContent - Thin Next.js wrapper for SignInForm
 */
function SignInContent() {
  const t = useTranslations('AuthSignIn');
  const tHome = useTranslations('Home');
  const tFooter = useTranslations('Footer');
  const searchParams = useSearchParams();
  const router = useRouter();
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const { setSession } = useAuthContext();
  const apiClient = useMemo(() => new SemiontApiClient({ baseUrl: baseUrl(NEXT_PUBLIC_BACKEND_URL) }), []);

  const [error, setError] = useState<string | null>(null);
  const [isLoading] = useState(false);
  const googleScriptLoaded = useRef(false);

  const callbackUrl = searchParams?.get('callbackUrl') || '/know';

  // Load Google Identity Services script once
  useEffect(() => {
    if (!NEXT_PUBLIC_GOOGLE_CLIENT_ID || googleScriptLoaded.current) return;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
    googleScriptLoaded.current = true;
  }, []);

  const handleGoogleSignIn = async () => {
    if (!NEXT_PUBLIC_GOOGLE_CLIENT_ID) {
      setError(t('errorGoogleSignIn'));
      return;
    }
    setError(null);
    window.google?.accounts.id.initialize({
      client_id: NEXT_PUBLIC_GOOGLE_CLIENT_ID,
      callback: async ({ credential }) => {
        try {
          const response = await apiClient.authenticateGoogle(googleCredential(credential));
          setSession({ token: response.token, user: response.user as any });
          router.push(callbackUrl);
        } catch {
          setError(t('errorGoogleSignIn'));
        }
      },
    });
    window.google?.accounts.id.prompt();
  };

  const handleCredentialsSignIn = async (email: string, password: string) => {
    setError(null);
    try {
      const response = await apiClient.authenticatePassword(makeEmail(email), password);
      setSession({ token: response.token, user: response.user as any });
      router.push(callbackUrl);
    } catch {
      setError(t('errorInvalidCredentials'));
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
    signInWithCredentials: t('signInWithCredentials'),
    or: t('or'),
    credentialsAuthEnabled: t('credentialsAuthEnabled'),
    approvedDomainsOnly: t('approvedDomainsOnly'),
    backToHome: t('backToHome'),
    learnMore: t('learnMore'),
    signUpInstead: t('signUpInstead'),
    errorEmailRequired: t('errorEmailRequired'),
    errorPasswordRequired: t('errorPasswordRequired'),
    tagline: tHome('tagline'),
  };

  return (
    <div className="semiont-page-wrapper">
      <SignInForm
        onGoogleSignIn={NEXT_PUBLIC_GOOGLE_CLIENT_ID ? handleGoogleSignIn : undefined as any}
        onCredentialsSignIn={handleCredentialsSignIn}
        error={error}
        showCredentialsAuth={true}
        isLoading={isLoading}
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
