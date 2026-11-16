import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCookieConsent,
  setCookieConsent,
  shouldShowBanner,
  isGDPRApplicable,
  isCCPAApplicable,
  CONSENT_COOKIE_NAME,
  CONSENT_VERSION,
  COOKIE_CATEGORIES,
  cleanupCookies,
  exportUserData
} from '../cookies';

// Mock document.cookie
Object.defineProperty(document, 'cookie', {
  writable: true,
  value: ''
});

// Mock navigator
Object.defineProperty(navigator, 'language', {
  writable: true,
  value: 'en-US'
});

// Mock fetch for geolocation
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Cookie Utilities', () => {
  beforeEach(() => {
    // Clear localStorage and cookies
    localStorage.clear();
    document.cookie = '';
    vi.clearAllMocks();
    
    // The vi.clearAllMocks() above already resets the fetch mock
  });

  describe('getCookieConsent', () => {
    it('should return null when no consent is stored', () => {
      const consent = getCookieConsent();
      expect(consent).toBeNull();
    });

    it('should return stored consent', () => {
      const mockConsent = {
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true,
        timestamp: '2024-01-01T00:00:00Z',
        version: CONSENT_VERSION
      };
      
      localStorage.setItem(CONSENT_COOKIE_NAME, JSON.stringify(mockConsent));
      
      const consent = getCookieConsent();
      expect(consent).toEqual(mockConsent);
    });

    it('should handle invalid JSON gracefully', () => {
      localStorage.setItem(CONSENT_COOKIE_NAME, 'invalid-json');
      
      const consent = getCookieConsent();
      expect(consent).toBeNull();
    });

    it('should return null for old consent format (forces re-consent)', () => {
      const oldConsent = {
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true,
        // Missing timestamp and version - should be treated as invalid
      };
      
      localStorage.setItem(CONSENT_COOKIE_NAME, JSON.stringify(oldConsent));
      
      const consent = getCookieConsent();
      expect(consent).toBeNull(); // Forces user to re-consent with new version
    });
  });

  describe('setCookieConsent', () => {
    it('should store consent with timestamp and version', () => {
      const preferences = {
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true
      };
      
      setCookieConsent(preferences);
      
      const stored = JSON.parse(localStorage.getItem(CONSENT_COOKIE_NAME) || '{}');
      expect(stored).toMatchObject(preferences);
      expect(stored).toHaveProperty('timestamp');
      expect(stored).toHaveProperty('version', CONSENT_VERSION);
    });

    it('should dispatch custom event when consent changes', () => {
      const eventListener = vi.fn();
      window.addEventListener('cookieConsentChanged', eventListener);
      
      setCookieConsent({
        necessary: true,
        analytics: true,
        marketing: true,
        preferences: true
      });
      
      expect(eventListener).toHaveBeenCalled();
      
      window.removeEventListener('cookieConsentChanged', eventListener);
    });

    it('should clean up cookies when consent is revoked', () => {
      // Set some test cookies first
      document.cookie = '_ga=test-analytics; path=/';
      document.cookie = '_fbp=test-marketing; path=/';
      document.cookie = 'theme-preference=dark; path=/';
      
      const consent = {
        necessary: true,
        analytics: false,  // Revoked - should clean up _ga
        marketing: false,  // Revoked - should clean up _fbp
        preferences: false // Revoked - should clean up theme-preference
      };
      
      setCookieConsent(consent);
      
      // Check that non-consented cookies were cleaned up
      const remainingCookies = document.cookie;
      expect(remainingCookies).not.toContain('_ga=');
      expect(remainingCookies).not.toContain('_fbp=');
      expect(remainingCookies).not.toContain('theme-preference=');
    });
  });

  describe('shouldShowBanner', () => {
    it('should return true when no consent exists', () => {
      expect(shouldShowBanner()).toBe(true);
    });

    it('should return false when valid consent exists', () => {
      setCookieConsent({
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true
      });
      
      expect(shouldShowBanner()).toBe(false);
    });

    it('should return true when consent version is outdated', () => {
      const outdatedConsent = {
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true,
        timestamp: '2024-01-01T00:00:00Z',
        version: '0.9' // Old version
      };
      
      localStorage.setItem(CONSENT_COOKIE_NAME, JSON.stringify(outdatedConsent));
      
      expect(shouldShowBanner()).toBe(true);
    });

    it('should return true when consent is expired (>1 year)', () => {
      const oldDate = new Date();
      oldDate.setFullYear(oldDate.getFullYear() - 2); // 2 years ago
      
      const expiredConsent = {
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true,
        timestamp: oldDate.toISOString(),
        version: CONSENT_VERSION
      };
      
      localStorage.setItem(CONSENT_COOKIE_NAME, JSON.stringify(expiredConsent));
      
      expect(shouldShowBanner()).toBe(true);
    });
  });

  describe('Region Detection', () => {
    describe('isGDPRApplicable', () => {
      it('should return true for EU timezone', async () => {
        // Mock Intl.DateTimeFormat to return EU timezone
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => ({
          resolvedOptions: () => ({ timeZone: 'Europe/Berlin' })
        } as any));
        
        const result = await isGDPRApplicable();
        expect(result).toBe(true);
      });

      it('should return false for non-EU timezone', async () => {
        // Mock Intl.DateTimeFormat to return US timezone
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => ({
          resolvedOptions: () => ({ timeZone: 'America/New_York' })
        } as any));
        
        const result = await isGDPRApplicable();
        expect(result).toBe(false);
      });

      it('should return false for non-EU country', async () => {
        (navigator as any).language = 'en-US';
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ country_code: 'US' })
        });
        
        const result = await isGDPRApplicable();
        expect(result).toBe(false);
      });

      it('should handle geolocation API errors gracefully', async () => {
        (navigator as any).language = 'en-US';
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        
        const result = await isGDPRApplicable();
        expect(result).toBe(false);
      });

      it('should handle timezone errors gracefully', async () => {
        // Mock Intl.DateTimeFormat to throw an error
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
          throw new Error('Timezone error');
        });
        
        const result = await isGDPRApplicable();
        expect(result).toBe(false); // Should default to false when error occurs
      });
    });

    describe('isCCPAApplicable', () => {
      it('should return true for California timezone', async () => {
        // Mock timezone
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => ({
          resolvedOptions: () => ({ timeZone: 'America/Los_Angeles' })
        } as any));
        
        const result = await isCCPAApplicable();
        expect(result).toBe(true);
      });

      it('should return false for non-CA timezone', async () => {
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => ({
          resolvedOptions: () => ({ timeZone: 'America/New_York' })
        } as any));
        
        const result = await isCCPAApplicable();
        expect(result).toBe(false);
      });

      it('should return false for non-California users', async () => {
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => ({
          resolvedOptions: () => ({ timeZone: 'America/New_York' })
        } as any));
        
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ 
            country_code: 'US',
            region: 'New York'
          })
        });
        
        const result = await isCCPAApplicable();
        expect(result).toBe(false);
      });
    });
  });

  describe('cleanupCookies', () => {
    it('should process all cookie categories correctly', () => {
      // Test that the function runs without errors for different consent configurations
      expect(() => {
        cleanupCookies({
          necessary: true,
          analytics: false,
          marketing: false,
          preferences: false,
          timestamp: new Date().toISOString(),
          version: CONSENT_VERSION
        });
      }).not.toThrow();
    });

    it('should handle different consent combinations', () => {
      // Test various consent combinations
      const testCases = [
        { necessary: true, analytics: true, marketing: false, preferences: true },
        { necessary: true, analytics: false, marketing: true, preferences: false },
        { necessary: true, analytics: true, marketing: true, preferences: true },
        { necessary: true, analytics: false, marketing: false, preferences: false }
      ];
      
      testCases.forEach(consent => {
        expect(() => {
          cleanupCookies({
            ...consent,
            timestamp: new Date().toISOString(),
            version: CONSENT_VERSION
          });
        }).not.toThrow();
      });
    });

    it('should handle wildcard cookie patterns', () => {
      document.cookie = '_ga_ABC123=test; path=/';
      document.cookie = '_ga_XYZ789=test; path=/';
      
      cleanupCookies({
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        timestamp: new Date().toISOString(),
        version: CONSENT_VERSION
      });
      
      const remainingCookies = document.cookie;
      expect(remainingCookies).not.toContain('_ga_');
    });
  });

  describe('exportUserData', () => {
    it('should export consent and cookie data', () => {
      // Set consent
      setCookieConsent({
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true
      });
      
      // Set some test cookies that are easier to control in JSDOM
      document.cookie = 'testcookie=testvalue';
      document.cookie = 'anothercookie=anothervalue';
      localStorage.setItem('testLocalStorage', 'testValue');
      
      const exportData = exportUserData();
      
      // Check that localStorage consent data is exported
      expect(exportData).toHaveProperty(`localStorage_${CONSENT_COOKIE_NAME}`);
      expect(exportData).toHaveProperty('localStorage_testLocalStorage');
      
      // Check that at least some cookies are exported with cookie_ prefix
      const cookieKeys = Object.keys(exportData).filter(key => key.startsWith('cookie_'));
      expect(cookieKeys.length).toBeGreaterThan(0);
      
      // Check localStorage data
      expect(exportData['localStorage_testLocalStorage']).toBe('testValue');
    });

    it('should export data as key-value pairs', () => {
      document.cookie = 'test=value';
      localStorage.setItem('testKey', 'testValue');
      
      const exportData = exportUserData();
      
      // Should be a simple key-value object
      expect(typeof exportData).toBe('object');
      expect(exportData).toHaveProperty('cookie_test');
      expect(exportData).toHaveProperty('localStorage_testKey');
      expect(exportData['cookie_test']).toBe('value');
      expect(exportData['localStorage_testKey']).toBe('testValue');
    });
  });

  describe('Cookie Categories', () => {
    it('should have all required categories', () => {
      expect(COOKIE_CATEGORIES).toHaveLength(4);
      
      const categoryIds = COOKIE_CATEGORIES.map(c => c.id);
      expect(categoryIds).toContain('necessary');
      expect(categoryIds).toContain('analytics');
      expect(categoryIds).toContain('marketing');
      expect(categoryIds).toContain('preferences');
    });

    it('should mark necessary cookies as required', () => {
      const necessaryCategory = COOKIE_CATEGORIES.find(c => c.id === 'necessary');
      expect(necessaryCategory?.required).toBe(true);
      
      const otherCategories = COOKIE_CATEGORIES.filter(c => c.id !== 'necessary');
      otherCategories.forEach(category => {
        expect(category.required).toBe(false);
      });
    });
  });
});