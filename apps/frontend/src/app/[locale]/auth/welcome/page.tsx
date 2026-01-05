'use client';

/**
 * Welcome Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (routing, auth, API calls)
 * and delegates rendering to the pure React WelcomePage component.
 */

import React, { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { PageLayout, useToast, useAuthApi } from '@semiont/react-ui';
import { WelcomePage } from '@/features/auth-welcome/components/WelcomePage';

export default function Welcome() {
  const t = useTranslations('AuthWelcome');
  const { data: session, status } = useSession();
  const router = useRouter();
  const [termsAccepted, setTermsAccepted] = useState(false);
  const toast = useToast();

  // API hooks
  const authAPI = useAuthApi();

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
      toast.showError(t('errorAcceptingTerms'));
    }
  };

  // Determine status
  const pageStatus = status === 'loading' ? 'loading' : termsAccepted ? 'accepted' : 'form';

  return (
    <WelcomePage
      userName={session?.user?.name?.split(' ')[0] ?? ''}
      termsAcceptedAt={userData?.termsAcceptedAt ?? null}
      isNewUser={session?.isNewUser ?? false}
      status={pageStatus}
      isProcessing={acceptTermsMutation.isPending}
      onAccept={() => handleTermsAcceptance(true)}
      onDecline={() => handleTermsAcceptance(false)}
      translations={{
        loading: t('loading'),
        welcomeTitle: t('welcomeTitle'),
        thanksForAccepting: t('thanksForAccepting'),
        welcomeUser: t('welcomeUser', { firstName: session?.user?.name?.split(' ')[0] ?? '' }),
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