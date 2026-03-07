import type { CookieCategory, CookieConsent } from './types';

// Cookie categories with descriptions
export const COOKIE_CATEGORIES: CookieCategory[] = [
  {
    id: 'necessary',
    name: 'Strictly Necessary',
    description: 'These cookies are essential for the website to function properly. They enable core functionality such as security, network management, and accessibility.',
    required: true,
    cookies: ['next-auth.session-token', 'next-auth.csrf-token', 'consent-preferences']
  },
  {
    id: 'analytics',
    name: 'Analytics',
    description: 'These cookies help us understand how visitors interact with our website by collecting and reporting information anonymously.',
    required: false,
    cookies: ['_ga', '_ga_*', '_gid', '_gat', 'lighthouse-*']
  },
  {
    id: 'marketing',
    name: 'Marketing',
    description: 'These cookies are used to track visitors across websites to display relevant advertisements and measure campaign effectiveness.',
    required: false,
    cookies: ['_fbp', '_fbc', 'fr', 'ads-*']
  },
  {
    id: 'preferences',
    name: 'Preferences',
    description: 'These cookies remember your choices and preferences to provide a more personalized experience.',
    required: false,
    cookies: ['theme-preference', 'language-preference', 'ui-settings']
  }
];

// Current consent version (increment when privacy policy changes)
export const CONSENT_VERSION = '1.0';

// Cookie names
export const CONSENT_COOKIE_NAME = 'semiont-cookie-consent';
export const PREFERENCES_COOKIE_NAME = 'semiont-cookie-preferences';

// Default consent state
export const DEFAULT_CONSENT: CookieConsent = {
  necessary: true, // Always true, required for functionality
  analytics: false,
  marketing: false,
  preferences: false,
  timestamp: new Date().toISOString(),
  version: CONSENT_VERSION
};
