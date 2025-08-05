import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../route';
import type { CookieExportData } from '../route';

// Import root config system (SEMIONT_ENV=test is set by scripts/test.ts)
const { config } = require('semiont-config');

// Extract test configuration values from root config
const TEST_CONFIG = {
  API_BASE_URL: `http://${config.app.backend.host}:${config.app.backend.port}`,
  FRONTEND_BASE_URL: `http://${config.app.backend.frontend.host}:${config.app.backend.frontend.port}`,
};

// Mock next-auth
const mockGetServerSession = vi.fn();
vi.mock('next-auth', () => ({
  getServerSession: () => mockGetServerSession()
}));

// Mock auth options
vi.mock('@/lib/auth', () => ({
  authOptions: {
    providers: [],
    pages: {
      signIn: '/auth/signin',
      error: '/auth/error'
    },
    callbacks: {},
    session: { strategy: 'jwt' }
  }
}));

describe('Cookies Export Route', () => {
  const mockRequest = new NextRequest(`${TEST_CONFIG.FRONTEND_BASE_URL}/api/cookies/export`);
  const mockBackendUser = {
    id: 'user-123',
    email: 'test@example.com'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2023-12-01T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Authentication', () => {
    it('should return 401 when no session exists', async () => {
      mockGetServerSession.mockResolvedValue(null);

      const response = await GET(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({
        success: false,
        error: 'Not authenticated'
      });
    });

    it('should return 401 when session exists but no backendUser', async () => {
      mockGetServerSession.mockResolvedValue({
        user: { email: 'test@example.com' }
        // No backendUser property
      });

      const response = await GET(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({
        success: false,
        error: 'Not authenticated'
      });
    });

    it('should call getServerSession with auth options', async () => {
      mockGetServerSession.mockResolvedValue({
        backendUser: mockBackendUser
      });

      await GET(mockRequest);

      expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('Successful Export', () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue({
        backendUser: mockBackendUser
      });
    });

    it('should return cookie export data with correct structure', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      const expectedData: CookieExportData = {
        user: {
          id: 'user-123',
          email: 'test@example.com'
        },
        consent: {
          necessary: true,
          analytics: false,
          marketing: false,
          preferences: false,
          timestamp: '2023-12-01T10:00:00.000Z',
          version: '1.0'
        },
        exportDate: '2023-12-01T10:00:00.000Z',
        dataRetentionPolicy: 'Cookie consent data is retained for 2 years from last update or until explicitly withdrawn.'
      };

      expect(response.status).toBe(200);
      expect(data).toEqual(expectedData);
    });

    it('should include user data from backend session', async () => {
      const customUser = {
        id: 'custom-456',
        email: 'custom@test.com'
      };

      mockGetServerSession.mockResolvedValue({
        backendUser: customUser
      });

      const response = await GET(mockRequest);
      const data = await response.json();

      expect(data.user).toEqual({
        id: 'custom-456',
        email: 'custom@test.com'
      });
    });

    it('should include consent data with proper defaults', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      expect(data.consent).toEqual({
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        timestamp: '2023-12-01T10:00:00.000Z',
        version: '1.0'
      });
    });

    it('should include current timestamp for export date', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      expect(data.exportDate).toBe('2023-12-01T10:00:00.000Z');
    });

    it('should include data retention policy', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      expect(data.dataRetentionPolicy).toBe(
        'Cookie consent data is retained for 2 years from last update or until explicitly withdrawn.'
      );
    });
  });

  describe('Response Headers', () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue({
        backendUser: mockBackendUser
      });
    });

    it('should set correct Content-Type header', async () => {
      const response = await GET(mockRequest);

      expect(response.headers.get('Content-Type')).toBe('application/json');
    });

    it('should set Content-Disposition header for file download', async () => {
      const response = await GET(mockRequest);
      const contentDisposition = response.headers.get('Content-Disposition');

      expect(contentDisposition).toMatch(/^attachment; filename="cookie-data-export-\d+\.json"$/);
    });

    it('should generate unique filename with timestamp', async () => {
      const timestamp = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(timestamp);

      const response = await GET(mockRequest);
      const contentDisposition = response.headers.get('Content-Disposition');

      expect(contentDisposition).toBe(`attachment; filename="cookie-data-export-${timestamp}.json"`);
    });
  });

  describe('Response Format', () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue({
        backendUser: mockBackendUser
      });
    });

    it('should return properly formatted JSON', async () => {
      const response = await GET(mockRequest);
      const responseText = await response.text();

      // Should be formatted JSON with 2-space indentation
      expect(responseText).toContain('{\n  "user": {\n    "id": "user-123",');
      expect(() => JSON.parse(responseText)).not.toThrow();
    });

    it('should return valid JSON that matches the TypeScript interface', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      // Verify all required properties exist
      expect(data).toHaveProperty('user');
      expect(data).toHaveProperty('consent');
      expect(data).toHaveProperty('exportDate');
      expect(data).toHaveProperty('dataRetentionPolicy');

      // Verify nested properties
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

  describe('Error Handling', () => {
    it('should handle getServerSession errors gracefully', async () => {
      mockGetServerSession.mockRejectedValue(new Error('Session error'));

      const response = await GET(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data).toEqual({
        success: false,
        error: 'Internal server error'
      });
    });

    it('should log errors to console', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGetServerSession.mockRejectedValue(new Error('Test error'));

      await GET(mockRequest);

      expect(consoleSpy).toHaveBeenCalledWith('Failed to export cookie data:', expect.any(Error));
      
      consoleSpy.mockRestore();
    });
  });

  describe('GDPR Compliance', () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue({
        backendUser: mockBackendUser
      });
    });

    it('should export data in machine-readable format', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      // Should be valid JSON object
      expect(typeof data).toBe('object');
      expect(data).not.toBeNull();
      expect(Array.isArray(data)).toBe(false);
    });

    it('should include all consent categories', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      const consentCategories = ['necessary', 'analytics', 'marketing', 'preferences'];
      consentCategories.forEach(category => {
        expect(data.consent).toHaveProperty(category);
        expect(typeof data.consent[category]).toBe('boolean');
      });
    });

    it('should include consent timestamp for audit trail', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      expect(data.consent.timestamp).toBe('2023-12-01T10:00:00.000Z');
      expect(new Date(data.consent.timestamp)).toBeInstanceOf(Date);
    });

    it('should include consent version for policy changes', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      expect(data.consent.version).toBe('1.0');
      expect(typeof data.consent.version).toBe('string');
    });

    it('should include clear data retention policy', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      expect(data.dataRetentionPolicy).toContain('2 years');
      expect(data.dataRetentionPolicy).toContain('retained');
      expect(data.dataRetentionPolicy).toContain('withdrawn');
    });

    it('should only export user-specific data', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      // Should only contain user data, not system-wide data
      expect(data.user.id).toBe('user-123');
      expect(data.user.email).toBe('test@example.com');
      
      // Should not contain sensitive system information
      expect(data).not.toHaveProperty('systemConfig');
      expect(data).not.toHaveProperty('internalId');
      expect(data).not.toHaveProperty('hashedPassword');
    });
  });

  describe('Data Privacy', () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue({
        backendUser: mockBackendUser
      });
    });

    it('should not expose sensitive session data', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      // Should not include session tokens or internal data
      expect(data).not.toHaveProperty('accessToken');
      expect(data).not.toHaveProperty('refreshToken');
      expect(data).not.toHaveProperty('sessionId');
      expect(data).not.toHaveProperty('sessionData');
    });

    it('should provide downloadable file format', async () => {
      const response = await GET(mockRequest);
      const contentDisposition = response.headers.get('Content-Disposition');

      expect(contentDisposition).toContain('attachment');
      expect(contentDisposition).toContain('.json');
    });

    it('should format timestamps in ISO format', async () => {
      const response = await GET(mockRequest);
      const data = await response.json();

      // ISO format: YYYY-MM-DDTHH:mm:ss.sssZ
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(data.exportDate).toMatch(isoRegex);
      expect(data.consent.timestamp).toMatch(isoRegex);
    });
  });

  describe('TypeScript Interface Compliance', () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue({
        backendUser: mockBackendUser
      });
    });

    it('should return data matching CookieExportData interface', async () => {
      const response = await GET(mockRequest);
      const data: CookieExportData = await response.json();

      // Should compile without TypeScript errors
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