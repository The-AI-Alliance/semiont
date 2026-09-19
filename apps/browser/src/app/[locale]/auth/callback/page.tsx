import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/i18n/routing';
import { useSemiont, useToast } from '@semiont/react-ui';
import { IdentityUnverifiableError, SignInError } from '@semiont/sdk';

/**
 * Where the issuer sends the user back. Completes the pending sign-in once
 * — an authorization code is single-use, and StrictMode mounts twice —
 * says so when the knowledge base that answered is not the one they
 * clicked, and lands them in the knowledge section; a sign-in that cannot
 * complete lands on the auth error page with the reason.
 */
export default function AuthCallback() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`KnowledgeBasePanel.${k}`, p as any) as string;
  const semiont = useSemiont();
  const router = useRouter();
  const { showWarning, showError } = useToast();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void semiont.completeSignIn(window.location.href).then(
      ({ kb, expected }) => {
        if (expected && expected.did !== kb.did) {
          showWarning(t('connectedToOther', {
            actual: kb.label || t('unknownName'),
            expected: expected.name || t('unknownName'),
          }));
        }
        router.replace('/know/discover');
      },
      (err: unknown) => {
        if (err instanceof IdentityUnverifiableError) {
          showError(err.reason === 'unreachable' ? t('identityCheckFailed') : t('identityNotReported'));
          router.replace('/know/discover');
          return;
        }
        const reason = err instanceof SignInError && err.code === 'denied'
          ? 'AccessDenied'
          : err instanceof SignInError && (err.code === 'no-issuer' || err.code === 'discovery')
            ? 'Configuration'
            : 'Verification';
        router.replace(`/auth/error?error=${reason}`);
      },
    );
  }, [semiont, router, showWarning, showError, t]);

  return (
    <p style={{ padding: '2rem', textAlign: 'center' }} aria-live="polite">
      {t('signingIn')}
    </p>
  );
}
