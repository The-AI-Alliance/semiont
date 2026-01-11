import type { CookieConsent } from './types';
import { CONSENT_COOKIE_NAME, CONSENT_VERSION, DEFAULT_CONSENT } from './constants';
import { cleanupCookies } from './cleanup';

export const getCookieConsent = (): CookieConsent | null => {
  if (typeof window === 'undefined') return null;

  try {
    const consent = localStorage.getItem(CONSENT_COOKIE_NAME);
    if (!consent) return null;

    const parsed = JSON.parse(consent) as CookieConsent;

    // Check if consent is for current version
    if (parsed.version !== CONSENT_VERSION) {
      return null; // Force re-consent for new version
    }

    return parsed;
  } catch (error) {
    console.warn('Failed to parse cookie consent:', error);
    return null;
  }
};

export const setCookieConsent = (consent: Partial<CookieConsent>): void => {
  if (typeof window === 'undefined') return;

  const fullConsent: CookieConsent = {
    ...DEFAULT_CONSENT,
    ...consent,
    necessary: true, // Always true
    timestamp: new Date().toISOString(),
    version: CONSENT_VERSION
  };

  try {
    localStorage.setItem(CONSENT_COOKIE_NAME, JSON.stringify(fullConsent));

    // Clean up cookies based on consent
    cleanupCookies(fullConsent);

    // Dispatch custom event for components to react to consent changes
    window.dispatchEvent(new CustomEvent('cookieConsentChanged', {
      detail: fullConsent
    }));
  } catch (error) {
    console.error('Failed to save cookie consent:', error);
  }
};

export const hasValidConsent = (): boolean => {
  const consent = getCookieConsent();
  if (!consent) return false;

  // Check if consent is less than 13 months old (GDPR requirement)
  const consentDate = new Date(consent.timestamp);
  const thirteenMonthsAgo = new Date();
  thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);

  return consentDate > thirteenMonthsAgo;
};

export const shouldShowBanner = (): boolean => {
  if (typeof window === 'undefined') return false;
  return !hasValidConsent();
};
