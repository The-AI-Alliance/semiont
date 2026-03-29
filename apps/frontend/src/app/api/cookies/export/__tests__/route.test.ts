import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../route';
import type { CookieExportData } from '../route';

const getFrontendUrl = () => 'http://localhost:3000';

const makeRequest = (withToken = true, jwtPayload?: object) => {
  const req = new NextRequest(`${getFrontendUrl()}/api/cookies/export`);
  if (withToken) {
    // Build a minimal JWT with the given payload (base64url-encoded, not signed)
    const payload = jwtPayload ?? { sub: 'user-123', email: 'test@example.com' };
    const token = `header.${btoa(JSON.stringify(payload)).replace(/=/g, '')}.sig`;
    Object.defineProperty(req, 'cookies', {
      value: { get: (name: string) => name === 'semiont-token' ? { value: token } : undefined },
      writable: false,
    });
  }
  return req;
};

describe('Cookies Export Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2023-12-01T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Authentication', () => {
    it('should return 401 when no token cookie exists', async () => {
      const req = makeRequest(false);
      const response = await GET(req);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({ success: false, error: 'Not authenticated' });
    });

    it('should return 200 when semiont-token cookie is present', async () => {
      const req = makeRequest(true);
      const response = await GET(req);

      expect(response.status).toBe(200);
    });
  });

  describe('Successful Export', () => {
    it('should return cookie export data with correct structure', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      const expectedData: CookieExportData = {
        user: {
          id: 'user-123',
          email: 'test@example.com',
        },
        consent: {
          necessary: true,
          analytics: false,
          marketing: false,
          preferences: false,
          timestamp: '2023-12-01T10:00:00.000Z',
          version: '1.0',
        },
        exportDate: '2023-12-01T10:00:00.000Z',
        dataRetentionPolicy: 'Cookie consent data is retained for 2 years from last update or until explicitly withdrawn.',
      };

      expect(response.status).toBe(200);
      expect(data).toEqual(expectedData);
    });

    it('should include user data parsed from JWT', async () => {
      const req = makeRequest(true, { sub: 'custom-456', email: 'custom@test.com' });
      const response = await GET(req);
      const data = await response.json();

      expect(data.user).toEqual({ id: 'custom-456', email: 'custom@test.com' });
    });

    it('should include consent data with proper defaults', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(data.consent).toEqual({
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        timestamp: '2023-12-01T10:00:00.000Z',
        version: '1.0',
      });
    });

    it('should include current timestamp for export date', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(data.exportDate).toBe('2023-12-01T10:00:00.000Z');
    });

    it('should include data retention policy', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(data.dataRetentionPolicy).toBe(
        'Cookie consent data is retained for 2 years from last update or until explicitly withdrawn.'
      );
    });
  });

  describe('Response Headers', () => {
    it('should set correct Content-Type header', async () => {
      const req = makeRequest(true);
      const response = await GET(req);

      expect(response.headers.get('Content-Type')).toBe('application/json');
    });

    it('should set Content-Disposition header for file download', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const contentDisposition = response.headers.get('Content-Disposition');

      expect(contentDisposition).toMatch(/^attachment; filename="cookie-data-export-\d+\.json"$/);
    });

    it('should generate unique filename with timestamp', async () => {
      const timestamp = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(timestamp);

      const req = makeRequest(true);
      const response = await GET(req);
      const contentDisposition = response.headers.get('Content-Disposition');

      expect(contentDisposition).toBe(`attachment; filename="cookie-data-export-${timestamp}.json"`);
    });
  });

  describe('Response Format', () => {
    it('should return properly formatted JSON', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const responseText = await response.text();

      expect(responseText).toContain('{\n  "user": {\n    "id": "user-123",');
      expect(() => JSON.parse(responseText)).not.toThrow();
    });

    it('should return valid JSON that matches the TypeScript interface', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(data).toHaveProperty('user');
      expect(data).toHaveProperty('consent');
      expect(data).toHaveProperty('exportDate');
      expect(data).toHaveProperty('dataRetentionPolicy');
      expect(data.user).toHaveProperty('id');
      expect(data.user).toHaveProperty('email');
      expect(data.consent).toHaveProperty('necessary');
      expect(data.consent).toHaveProperty('analytics');
      expect(data.consent).toHaveProperty('marketing');
      expect(data.consent).toHaveProperty('preferences');
      expect(data.consent).toHaveProperty('timestamp');
      expect(data.consent).toHaveProperty('version');
    });
  });

  describe('GDPR Compliance', () => {
    it('should export data in machine-readable format', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(typeof data).toBe('object');
      expect(data).not.toBeNull();
      expect(Array.isArray(data)).toBe(false);
    });

    it('should include all consent categories', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      const consentCategories = ['necessary', 'analytics', 'marketing', 'preferences'];
      consentCategories.forEach(category => {
        expect(data.consent).toHaveProperty(category);
        expect(typeof data.consent[category]).toBe('boolean');
      });
    });

    it('should include consent timestamp for audit trail', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(data.consent.timestamp).toBe('2023-12-01T10:00:00.000Z');
      expect(new Date(data.consent.timestamp)).toBeInstanceOf(Date);
    });

    it('should include consent version for policy changes', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(data.consent.version).toBe('1.0');
      expect(typeof data.consent.version).toBe('string');
    });

    it('should include clear data retention policy', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(data.dataRetentionPolicy).toContain('2 years');
      expect(data.dataRetentionPolicy).toContain('retained');
      expect(data.dataRetentionPolicy).toContain('withdrawn');
    });

    it('should only export user-specific data', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(data.user.id).toBe('user-123');
      expect(data.user.email).toBe('test@example.com');
      expect(data).not.toHaveProperty('systemConfig');
      expect(data).not.toHaveProperty('internalId');
      expect(data).not.toHaveProperty('hashedPassword');
    });
  });

  describe('Data Privacy', () => {
    it('should not expose sensitive session data', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      expect(data).not.toHaveProperty('accessToken');
      expect(data).not.toHaveProperty('refreshToken');
      expect(data).not.toHaveProperty('sessionId');
      expect(data).not.toHaveProperty('sessionData');
    });

    it('should provide downloadable file format', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const contentDisposition = response.headers.get('Content-Disposition');

      expect(contentDisposition).toContain('attachment');
      expect(contentDisposition).toContain('.json');
    });

    it('should format timestamps in ISO format', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data = await response.json();

      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(data.exportDate).toMatch(isoRegex);
      expect(data.consent.timestamp).toMatch(isoRegex);
    });
  });

  describe('TypeScript Interface Compliance', () => {
    it('should return data matching CookieExportData interface', async () => {
      const req = makeRequest(true);
      const response = await GET(req);
      const data: CookieExportData = await response.json();

      expect(data.user.id).toBe('user-123');
      expect(data.user.email).toBe('test@example.com');
      expect(data.consent.necessary).toBe(true);
      expect(data.consent.analytics).toBe(false);
      expect(data.consent.marketing).toBe(false);
      expect(data.consent.preferences).toBe(false);
      expect(typeof data.consent.timestamp).toBe('string');
      expect(typeof data.consent.version).toBe('string');
      expect(typeof data.exportDate).toBe('string');
      expect(typeof data.dataRetentionPolicy).toBe('string');
    });
  });
});
