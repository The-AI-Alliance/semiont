/**
 * Content Negotiation Tests
 *
 * Tests W3C-compliant content negotiation for document and annotation URIs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from 'hono';
import { prefersHtml, prefersJsonLd, getFrontendUrl } from '../middleware/content-negotiation';

describe('Content Negotiation Middleware', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  beforeEach(() => {
    process.env.FRONTEND_URL = 'http://localhost:3000';
  });

  afterEach(() => {
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  describe('prefersHtml', () => {
    it('should return true when Accept header includes text/html', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'text/html,application/xhtml+xml';
            if (name === 'User-Agent') return 'curl/7.64.1';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(true);
    });

    it('should return true when User-Agent indicates Mozilla browser (without JSON Accept)', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'text/html';
            if (name === 'User-Agent') return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(true);
    });

    it('should return true when User-Agent indicates Chrome browser (without JSON Accept)', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'text/html';
            if (name === 'User-Agent') return 'Chrome/120.0.0.0 Safari/537.36';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(true);
    });

    it('should return true when User-Agent indicates Safari browser (without JSON Accept)', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'text/html';
            if (name === 'User-Agent') return 'Safari/605.1.15';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(true);
    });

    it('should return false for API clients (curl)', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'application/json';
            if (name === 'User-Agent') return 'curl/7.64.1';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(false);
    });

    it('should return false for API clients (fetch)', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'application/json';
            if (name === 'User-Agent') return 'node-fetch/1.0';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(false);
    });

    it('should handle missing Accept header', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return undefined;
            if (name === 'User-Agent') return 'curl/7.64.1';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(false);
    });

    it('should handle missing User-Agent header', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'application/json';
            if (name === 'User-Agent') return undefined;
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(false);
    });
  });

  describe('prefersJsonLd', () => {
    it('should return true when Accept header includes application/ld+json', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'application/ld+json';
            if (name === 'User-Agent') return 'curl/7.64.1';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersJsonLd(mockContext)).toBe(true);
    });

    it('should return true when Accept header includes application/json', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'application/json';
            if (name === 'User-Agent') return 'curl/7.64.1';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersJsonLd(mockContext)).toBe(true);
    });

    it('should return false when client prefers HTML', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'text/html';
            if (name === 'User-Agent') return 'Mozilla/5.0';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersJsonLd(mockContext)).toBe(false);
    });

    it('should return true by default for API clients (no Accept header)', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return undefined;
            if (name === 'User-Agent') return 'curl/7.64.1';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersJsonLd(mockContext)).toBe(true);
    });

    it('should return false for browsers (even without explicit Accept)', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return undefined;
            if (name === 'User-Agent') return 'Mozilla/5.0 (Macintosh)';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersJsonLd(mockContext)).toBe(false);
    });
  });

  describe('getFrontendUrl', () => {
    it('should return FRONTEND_URL from environment', () => {
      expect(getFrontendUrl()).toBe('http://localhost:3000');
    });

    it('should throw error when FRONTEND_URL is not set', () => {
      delete process.env.FRONTEND_URL;
      expect(() => getFrontendUrl()).toThrow('FRONTEND_URL environment variable is required');
    });
  });

  describe('Content Negotiation Priority', () => {
    it('should prefer HTML over JSON-LD for browsers', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'text/html,application/json;q=0.9';
            if (name === 'User-Agent') return 'Mozilla/5.0';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(true);
      expect(prefersJsonLd(mockContext)).toBe(false);
    });

    it('should prefer JSON-LD over HTML for API clients', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return 'application/ld+json';
            if (name === 'User-Agent') return 'curl/7.64.1';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(false);
      expect(prefersJsonLd(mockContext)).toBe(true);
    });

    it('should default to JSON-LD for ambiguous requests', () => {
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === 'Accept') return '*/*';
            if (name === 'User-Agent') return 'custom-client/1.0';
            return undefined;
          }
        }
      } as unknown as Context;

      expect(prefersHtml(mockContext)).toBe(false);
      expect(prefersJsonLd(mockContext)).toBe(true);
    });
  });
});
