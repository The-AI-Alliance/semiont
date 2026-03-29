import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { RequestInit as NextRequestInit } from 'next/dist/server/web/spec-extension/request'
import { GET, POST } from '../route'

const getFrontendUrl = () => 'http://localhost:3000';

// Helper to create a request optionally carrying the semiont-token cookie
const makeRequest = (path: string, options?: NextRequestInit, withToken = true) => {
  const req = new NextRequest(`${getFrontendUrl()}${path}`, options);
  if (withToken) {
    Object.defineProperty(req, 'cookies', {
      value: { get: (name: string) => name === 'semiont-token' ? { value: 'test.jwt.token' } : undefined },
      writable: false,
    });
  }
  return req;
};

describe('/api/cookies/consent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /api/cookies/consent', () => {
    it('should return consent data for authenticated user', async () => {
      const request = makeRequest('/api/cookies/consent');
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
      const request = makeRequest('/api/cookies/consent', undefined, false);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Not authenticated');
    });
  });

  describe('POST /api/cookies/consent', () => {
    it('should update consent preferences', async () => {
      const consentData = {
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true
      };

      const request = makeRequest('/api/cookies/consent', {
        method: 'POST',
        body: JSON.stringify(consentData),
        headers: { 'Content-Type': 'application/json' }
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

      const request = makeRequest('/api/cookies/consent', {
        method: 'POST',
        body: JSON.stringify(invalidData),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Invalid consent data');
    });

    it('should reject request with necessary cookies disabled', async () => {
      const invalidData = {
        necessary: false,
        analytics: true,
        marketing: false,
        preferences: true
      };

      const request = makeRequest('/api/cookies/consent', {
        method: 'POST',
        body: JSON.stringify(invalidData),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Necessary cookies cannot be disabled');
    });

    it('should return 401 for unauthenticated user', async () => {
      const request = makeRequest('/api/cookies/consent', {
        method: 'POST',
        body: JSON.stringify({ necessary: true, analytics: true, marketing: false, preferences: true }),
        headers: { 'Content-Type': 'application/json' }
      }, false);

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Not authenticated');
    });

    it('should handle malformed JSON gracefully', async () => {
      const request = makeRequest('/api/cookies/consent', {
        method: 'POST',
        body: 'invalid-json',
        headers: { 'Content-Type': 'application/json' }
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

      const request = makeRequest('/api/cookies/consent', {
        method: 'POST',
        body: JSON.stringify(incompleteData),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Invalid consent data');
    });
  });
});
