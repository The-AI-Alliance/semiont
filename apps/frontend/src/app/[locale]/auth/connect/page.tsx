import { useEffect, useState, useContext, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRouter } from '@/i18n/routing';
import { useTranslation } from 'react-i18next';
import { Footer, SignInForm } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';
import { Link } from '@/i18n/routing';
import { useAuthContext } from '@/contexts/AuthContext';
import { useWorkspaceContext } from '@/contexts/WorkspaceContext';
import { SemiontApiClient } from '@semiont/api-client';
import { googleCredential, email as makeEmail, baseUrl as makeBaseUrl } from '@semiont/core';
import { SEMIONT_GOOGLE_CLIENT_ID } from '@/lib/env';
import type { Workspace } from '@/contexts/WorkspaceContext';

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
 * Normalise a user-entered URL: add https:// if no scheme is present.
 */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export default function ConnectPage() {
  const { t: _t } = useTranslation();
  const t = (k: string) => _t(`AuthSignIn.${k}`) as string;
  const tFooter = (k: string, p?: Record<string, unknown>) => _t(`Footer.${k}`, p as any) as string;
  const [searchParams] = useSearchParams();
  const router = useRouter();
  const keyboardContext = useContext(KeyboardShortcutsContext);
  const { setSession } = useAuthContext();
  const { workspaces, addWorkspace } = useWorkspaceContext();

  const callbackUrl = searchParams.get('callbackUrl') ?? '/know';

  // If workspaceId is in the query string, we're re-authenticating to a known workspace.
  const workspaceId = searchParams.get('workspaceId');
  const knownWorkspace: Workspace | undefined = workspaceId
    ? workspaces.find(w => w.id === workspaceId)
    : undefined;

  // The locked URL shown in the form (undefined = user must enter it)
  const lockedBackendUrl = knownWorkspace?.backendUrl;

  const [error, setError] = useState<string | null>(null);
  const googleScriptLoaded = useRef(false);

  useEffect(() => {
    if (!SEMIONT_GOOGLE_CLIENT_ID || googleScriptLoaded.current) return;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
    googleScriptLoaded.current = true;
  }, []);

  const handleGoogleSignIn = async (backendUrl: string) => {
    if (!SEMIONT_GOOGLE_CLIENT_ID) {
      setError(t('errorGoogleSignIn'));
      return;
    }
    setError(null);
    const normalizedUrl = normalizeUrl(backendUrl);
    const client = new SemiontApiClient({ baseUrl: makeBaseUrl(normalizedUrl) });

    window.google?.accounts.id.initialize({
      client_id: SEMIONT_GOOGLE_CLIENT_ID,
      callback: async ({ credential }) => {
        try {
          const response = await client.authenticateGoogle(googleCredential(credential));
          if (!knownWorkspace) {
            addWorkspace({
              id: crypto.randomUUID(),
              label: new URL(normalizedUrl).hostname,
              backendUrl: normalizedUrl,
            });
          }
          setSession({ token: response.token, user: response.user as any });
          router.push(callbackUrl);
        } catch {
          setError(t('errorGoogleSignIn'));
        }
      },
    });
    window.google?.accounts.id.prompt();
  };

  const handleCredentialsSignIn = async (backendUrl: string, email: string, password: string) => {
    setError(null);
    const normalizedUrl = normalizeUrl(backendUrl);
    const client = new SemiontApiClient({ baseUrl: makeBaseUrl(normalizedUrl) });
    try {
      const response = await client.authenticatePassword(makeEmail(email), password);
      if (!knownWorkspace) {
        addWorkspace({
          id: crypto.randomUUID(),
          label: new URL(normalizedUrl).hostname,
          backendUrl: normalizedUrl,
        });
      }
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
    backendUrlLabel: t('backendUrlLabel'),
    backendUrlPlaceholder: t('backendUrlPlaceholder'),
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
    errorBackendUrlRequired: t('errorBackendUrlRequired'),
    errorEmailRequired: t('errorEmailRequired'),
    errorPasswordRequired: t('errorPasswordRequired'),
    tagline: _t('Home.tagline') as string,
  };

  return (
    <div className="semiont-page-wrapper">
      <SignInForm
        {...(lockedBackendUrl !== undefined && { backendUrl: lockedBackendUrl })}
        onGoogleSignIn={SEMIONT_GOOGLE_CLIENT_ID ? handleGoogleSignIn : undefined as any}
        onCredentialsSignIn={handleCredentialsSignIn}
        error={error}
        showCredentialsAuth={true}
        isLoading={false}
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
