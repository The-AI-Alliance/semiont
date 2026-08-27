import type { CookieConsent } from './types';
import { COOKIE_CATEGORIES } from './constants';

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
