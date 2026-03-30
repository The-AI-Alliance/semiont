/**
 * Welcome Page - Thin Next.js wrapper
 *
 * This page handles Next.js-specific concerns (routing, auth, API calls)
 * and delegates rendering to the pure React WelcomePage component.
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useAuthContext } from '@/contexts/AuthContext';
import { useRouter } from '@/i18n/routing';
import { useTranslation } from 'react-i18next';
import { Link } from '@/i18n/routing';
import { PageLayout, useToast, useAuthApi } from '@semiont/react-ui';
import { WelcomePage } from '@semiont/react-ui';

export default function Welcome() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AuthWelcome.${k}`, p as any) as string;
  const { isAuthenticated, isLoading, user } = useAuth();
  const { clearSession } = useAuthContext();
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
    if (isLoading) return;
    if (!isAuthenticated) {
      router.push('/auth/connect');
      return;
    }

    // Check if user has accepted terms
    if (userData?.termsAcceptedAt) {
      router.push('/');
      return;
    }

    // If terms already accepted, redirect to main app
    if (isAuthenticated && userData !== undefined && userData?.termsAcceptedAt) {
      router.push('/');
      return;
    }
  }, [isLoading, isAuthenticated, router, userData]);

  const handleTermsAcceptance = async (accepted: boolean) => {
    if (!accepted) {
      // User declined terms - clear session and redirect to home
      clearSession();
      router.push('/');
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
  const pageStatus = isLoading ? 'loading' : termsAccepted ? 'accepted' : 'form';
  const firstName = user?.name?.split(' ')[0] ?? '';

  return (
    <WelcomePage
      userName={firstName}
      termsAcceptedAt={userData?.termsAcceptedAt ?? null}
      isNewUser={!userData?.termsAcceptedAt}
      status={pageStatus}
      isProcessing={acceptTermsMutation.isPending}
      onAccept={() => handleTermsAcceptance(true)}
      onDecline={() => handleTermsAcceptance(false)}
      translations={{
        loading: t('loading'),
        welcomeTitle: t('welcomeTitle'),
        thanksForAccepting: t('thanksForAccepting'),
        welcomeUser: t('welcomeUser', { firstName }),
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
