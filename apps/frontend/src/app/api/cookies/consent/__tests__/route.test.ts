import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from '../route'
import { getServerSession } from 'next-auth'

// Import test config explicitly  
const { loadConfig } = require('semiont-config');
const testConfig = loadConfig('unit');
const getBackendUrl = () => testConfig.app.backend?.url?.origin || 'http://localhost:3001';
const getFrontendUrl = () => testConfig.app.frontend?.url?.origin || 'http://localhost:3000';


// Mock next-auth
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

// Mock authOptions
vi.mock('@/lib/auth', () => ({
  authOptions: {},
}))

describe('/api/cookies/consent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /api/cookies/consent', () => {
    it('should return consent data for authenticated user', async () => {
      (getServerSession as vi.Mock).mockResolvedValue({
        backendUser: {
          id: 'user123',
          email: 'test@example.com'
        }
      });

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.consent).toMatchObject({
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false
      });
      expect(data.consent).toHaveProperty('timestamp');
      expect(data.consent).toHaveProperty('version');
    });

    it('should return 401 for unauthenticated user', async () => {
      (getServerSession as vi.Mock).mockResolvedValue(null);

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Not authenticated');
    });

    it('should return 401 for user without backendUser', async () => {
      (getServerSession as vi.Mock).mockResolvedValue({
        user: { email: 'test@example.com' }
      });

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Not authenticated');
    });

    it('should handle server errors gracefully', async () => {
      (getServerSession as vi.Mock).mockRejectedValue(new Error('Database error'));

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Internal server error');
    });
  });

  describe('POST /api/cookies/consent', () => {
    beforeEach(() => {
      (getServerSession as vi.Mock).mockResolvedValue({
        backendUser: {
          id: 'user123',
          email: 'test@example.com'
        }
      });
    });

    it('should update consent preferences', async () => {
      const consentData = {
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true
      };

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`, {
        method: 'POST',
        body: JSON.stringify(consentData),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.consent).toMatchObject(consentData);
      expect(data.consent).toHaveProperty('timestamp');
      expect(data.consent).toHaveProperty('version', '1.0');
    });

    it('should reject request with invalid consent data', async () => {
      const invalidData = {
        necessary: true,
        analytics: 'invalid', // Should be boolean
        marketing: false,
        preferences: true
      };

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`, {
        method: 'POST',
        body: JSON.stringify(invalidData),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Invalid consent data');
    });

    it('should reject request with necessary cookies disabled', async () => {
      const invalidData = {
        necessary: false, // Cannot be false
        analytics: true,
        marketing: false,
        preferences: true
      };

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`, {
        method: 'POST',
        body: JSON.stringify(invalidData),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Necessary cookies cannot be disabled');
    });

    it('should return 401 for unauthenticated user', async () => {
      (getServerSession as vi.Mock).mockResolvedValue(null);

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`, {
        method: 'POST',
        body: JSON.stringify({
          necessary: true,
          analytics: true,
          marketing: false,
          preferences: true
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Not authenticated');
    });

    it('should handle malformed JSON gracefully', async () => {
      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`, {
        method: 'POST',
        body: 'invalid-json',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Internal server error');
    });

    it('should handle missing required fields', async () => {
      const incompleteData = {
        necessary: true,
        analytics: true
        // Missing marketing and preferences
      };

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`, {
        method: 'POST',
        body: JSON.stringify(incompleteData),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Invalid consent data');
    });

    it('should handle server errors during save', async () => {
      (getServerSession as vi.Mock).mockRejectedValue(new Error('Database error'));

      const request = new NextRequest(`${getFrontendUrl()}/api/cookies/consent`, {
        method: 'POST',
        body: JSON.stringify({
          necessary: true,
          analytics: true,
          marketing: false,
          preferences: true
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Internal server error');
    });
  });
});