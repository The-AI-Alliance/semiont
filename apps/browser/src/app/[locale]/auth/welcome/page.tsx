/**
 * Welcome Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (routing, auth, API calls)
 * and delegates rendering to the pure React WelcomePage component.
 */

import { useState, useEffect } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslation } from 'react-i18next';
import { Link } from '@/i18n/routing';
import { PageLayout, useToast, useSemiont, useObservable } from '@semiont/react-ui';
import { WelcomePage } from '@semiont/react-ui';
import { createWelcomeStateUnit } from '@semiont/react-ui';
import { useSessionStateUnit } from '@semiont/react-ui';
import type { SemiontSession } from '@semiont/sdk';

/**
 * The session gate is API shape now (SESSION-TYPED-FACTORIES.md):
 * `createWelcomeStateUnit` takes the SESSION, and `useSessionStateUnit`
 * constructs only when one exists and rebuilds (dispose-first) when it is
 * replaced — a KB switch or re-auth can no longer leave this page holding a
 * disposed client. This route is where that crashed in production: the user
 * lands here immediately after connecting, mid-activation.
 * See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
 */
export default function Welcome() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AuthWelcome.${k}`, p as any) as string;
  const semiont = useSemiont();
  const session = useObservable(semiont.activeSession$) ?? null;

  if (!session) {
    return <WelcomeShell status="loading" t={t} />;
  }
  return <WelcomeInner key={session.id} session={session} t={t} />;
}

function WelcomeInner({
  session,
  t,
}: {
  session: SemiontSession;
  t: (k: string, p?: Record<string, unknown>) => string;
}) {
  const semiont = useSemiont();
  const user = useObservable(session.user$) ?? null;
  const activeKnowledgeBase = session.kb;
  const isAuthenticated = !!user;
  const signOut = (id: string) => { void semiont.signOut(id); };
  const router = useRouter();
  const [termsAccepted, setTermsAccepted] = useState(false);
  const toast = useToast();

  const stateUnit = useSessionStateUnit(session, createWelcomeStateUnit);

  const userData = useObservable(stateUnit?.userData$);
  const isProcessing = useObservable(stateUnit?.isProcessing$) ?? false;

  // Redirect if not authenticated or if terms already accepted
  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/auth/connect');
      return;
    }

    if (userData?.termsAcceptedAt) {
      router.push('/');
      return;
    }
  }, [isAuthenticated, router, userData]);

  const handleTermsAcceptance = async (accepted: boolean) => {
    if (!accepted) {
      if (activeKnowledgeBase) {
        signOut(activeKnowledgeBase.id);
      }
      router.push('/');
      return;
    }

    if (!stateUnit) return;
    try {
      await stateUnit.acceptTerms();
      setTermsAccepted(true);

      setTimeout(() => {
        router.push('/');
      }, 1000);
    } catch (error) {
      console.error('Terms acceptance error:', error);
      toast.showError(t('errorAcceptingTerms'));
    }
  };

  const pageStatus = termsAccepted ? 'accepted' : 'form';
  const firstName = user?.name?.split(' ')[0] ?? '';

  return (
    <WelcomeShell
      t={t}
      userName={firstName}
      termsAcceptedAt={userData?.termsAcceptedAt ?? null}
      status={pageStatus}
      isProcessing={isProcessing}
      onAccept={() => handleTermsAcceptance(true)}
      onDecline={() => handleTermsAcceptance(false)}
    />
  );
}

/**
 * The presentational half: every translation the WelcomePage needs, in one
 * place, so the pre-session loading render and the real one cannot drift.
 */
function WelcomeShell({
  t,
  status,
  userName = '',
  termsAcceptedAt = null,
  isProcessing = false,
  onAccept = () => {},
  onDecline = () => {},
}: {
  t: (k: string, p?: Record<string, unknown>) => string;
  status: 'loading' | 'accepted' | 'form';
  userName?: string;
  termsAcceptedAt?: string | null;
  isProcessing?: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
}) {
  return (
    <WelcomePage
      userName={userName}
      termsAcceptedAt={termsAcceptedAt}
      isNewUser={!termsAcceptedAt}
      status={status}
      isProcessing={isProcessing}
      onAccept={onAccept}
      onDecline={onDecline}
      translations={{
        loading: t('loading'),
        welcomeTitle: t('welcomeTitle'),
        thanksForAccepting: t('thanksForAccepting'),
        welcomeUser: t('welcomeUser', { firstName: userName }),
        reviewTermsPrompt: t('reviewTermsPrompt'),
        termsSummaryTitle: t('termsSummaryTitle'),
        termsSummaryIntro: t('termsSummaryIntro'),
        acceptableUseTitle: t('acceptableUseTitle'),
        acceptableUseResponsible: t('acceptableUseResponsible'),
        acceptableUseRespect: t('acceptableUseRespect'),
        acceptableUseConduct: t('acceptableUseConduct'),
        prohibitedContentTitle: t('prohibitedContentTitle'),
        prohibitedContentIntro: t('prohibitedContentIntro'),
        prohibitedIllegal: t('prohibitedIllegal'),
        prohibitedAdult: t('prohibitedAdult'),
        prohibitedHate: t('prohibitedHate'),
        prohibitedViolence: t('prohibitedViolence'),
        prohibitedMisinformation: t('prohibitedMisinformation'),
        prohibitedPrivacy: t('prohibitedPrivacy'),
        prohibitedCopyright: t('prohibitedCopyright'),
        prohibitedMalware: t('prohibitedMalware'),
        prohibitedSpam: t('prohibitedSpam'),
        conductTitle: t('conductTitle'),
        conductDescription: t('conductDescription'),
        conductLink: t('conductLink'),
        conductPromotion: t('conductPromotion'),
        responsibilitiesTitle: t('responsibilitiesTitle'),
        responsibilitiesSecure: t('responsibilitiesSecure'),
        responsibilitiesReport: t('responsibilitiesReport'),
        responsibilitiesAccurate: t('responsibilitiesAccurate'),
        responsibilitiesComply: t('responsibilitiesComply'),
        violationsWarning: t('violationsWarning'),
        readFullTerms: t('readFullTerms'),
        termsOfService: t('termsOfService'),
        and: t('and'),
        privacyPolicy: t('privacyPolicy'),
        declineAndSignOut: t('declineAndSignOut'),
        acceptAndContinue: t('acceptAndContinue'),
        processing: t('processing'),
        legallyBound: t('legallyBound'),
      }}
      PageLayout={PageLayout}
      Link={Link}
    />
  );
}
