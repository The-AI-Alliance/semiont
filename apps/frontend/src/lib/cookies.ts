// Cookie Management Utilities for GDPR/CCPA Compliance

export interface CookieConsent {
  necessary: boolean;
  analytics: boolean;
  marketing: boolean;
  preferences: boolean;
  timestamp: string;
  version: string;
}

export interface CookieCategory {
  id: keyof Omit<CookieConsent, 'timestamp' | 'version'>;
  name: string;
  description: string;
  required: boolean;
  cookies: string[];
}

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

// Utility functions
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

// Clean up cookies based on consent
export const cleanupCookies = (consent: CookieConsent): void => {
  if (typeof window === 'undefined') return;
  
  COOKIE_CATEGORIES.forEach(category => {
    if (category.required) return; // Never clean up required cookies
    
    const hasConsent = consent[category.id];
    if (!hasConsent) {
      // Remove cookies for this category
      category.cookies.forEach(cookieName => {
        if (cookieName.includes('*')) {
          // Handle wildcard cookies
          const prefix = cookieName.replace('*', '');
          document.cookie.split(';').forEach(cookie => {
            const name = cookie.split('=')[0]?.trim();
            if (name && name.startsWith(prefix)) {
              deleteCookie(name);
            }
          });
        } else {
          deleteCookie(cookieName);
        }
      });
    }
  });
};

// Delete a specific cookie
export const deleteCookie = (name: string): void => {
  // Delete for current domain
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  // Delete for parent domain
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${window.location.hostname}`;
  // Delete for root domain
  const rootDomain = window.location.hostname.split('.').slice(-2).join('.');
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.${rootDomain}`;
};

// Get user's location for CCPA vs GDPR detection (simplified)
export const getUserLocation = async (): Promise<'EU' | 'CA' | 'US' | 'OTHER'> => {
  try {
    // In a real implementation, you'd use a geolocation service
    // For now, we'll detect based on timezone as a rough approximation
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    if (timezone.includes('Europe/')) return 'EU';
    if (timezone.includes('America/Los_Angeles') || timezone.includes('America/Vancouver')) return 'CA';
    if (timezone.includes('America/')) return 'US';
    
    return 'OTHER';
  } catch {
    return 'OTHER';
  }
};

// Check if CCPA applies (California residents)
export const isCCPAApplicable = async (): Promise<boolean> => {
  const location = await getUserLocation();
  return location === 'CA';
};

// Check if GDPR applies (EU residents)
export const isGDPRApplicable = async (): Promise<boolean> => {
  const location = await getUserLocation();
  return location === 'EU';
};

// Export all cookies currently set
export const exportUserData = (): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  
  const data: Record<string, string> = {};
  
  // Get all cookies
  document.cookie.split(';').forEach(cookie => {
    const [name, value] = cookie.trim().split('=');
    if (name && value) {
      data[`cookie_${name}`] = decodeURIComponent(value);
    }
  });
  
  // Get localStorage data
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      data[`localStorage_${key}`] = localStorage.getItem(key) || '';
    }
  }
  
  // Get sessionStorage data
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key) {
      data[`sessionStorage_${key}`] = sessionStorage.getItem(key) || '';
    }
  }
  
  return data;
};

// Delete all user data (GDPR right to be forgotten)
export const deleteAllUserData = (): void => {
  if (typeof window === 'undefined') return;
  
  // Clear all localStorage
  localStorage.clear();
  
  // Clear all sessionStorage
  sessionStorage.clear();
  
  // Delete all cookies
  document.cookie.split(';').forEach(cookie => {
    const name = cookie.split('=')[0]?.trim();
    if (name) {
      deleteCookie(name);
    }
  });
  
  // Reload page to ensure clean state
  window.location.reload();
};