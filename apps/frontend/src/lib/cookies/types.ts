// Cookie Management Types for GDPR/CCPA Compliance

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
