export type { CookieConsent, CookieCategory } from './types';
export {
  COOKIE_CATEGORIES,
  CONSENT_VERSION,
  CONSENT_COOKIE_NAME,
  PREFERENCES_COOKIE_NAME,
  DEFAULT_CONSENT
} from './constants';
export {
  getCookieConsent,
  setCookieConsent,
  hasValidConsent,
  shouldShowBanner
} from './consent';
export {
  cleanupCookies,
  deleteCookie
} from './cleanup';
export {
  getUserLocation,
  isCCPAApplicable,
  isGDPRApplicable,
  exportUserData,
  deleteAllUserData
} from './privacy';
