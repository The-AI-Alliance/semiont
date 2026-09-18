/**
 * Contract tests - verify API matches shared types
 * These tests ensure the gateway API contract matches the shared types package
 */

import { describe, it, expect } from 'vitest';
import type { components } from '@semiont/core';

// Local type definitions to replace api-contracts imports
interface HealthResponse {
  status: string;
  message: string;
  version: string;
  timestamp: string;
  database: 'connected' | 'disconnected' | 'unknown';
  environment: string;
}

interface StatusResponse {
  status: string;
  version: string;
  features: {
    semanticContent: string;
    collaboration: string;
    rbac: string;
  };
  message: string;
  authenticatedAs?: string;
}


// The wire shape is the spec's, not this file's. It was restated here and had
// already drifted — no `isModerator`, no `token` — so a contract test was
// asserting against a contract nobody published.
type UserResponse = components['schemas']['UserResponse'];


interface ErrorResponse {
  error: string;
  code?: string;
  details?: any;
}


describe('API Contract Tests', () => {
  describe('Response Type Contracts', () => {
    it('should match HealthResponse contract', () => {
      const mockResponse: HealthResponse = {
        status: 'operational',
        message: 'Semiont API is running',
        version: '0.1.0',
        timestamp: '2024-01-01T00:00:00.000Z',
        database: 'connected',
        environment: 'test',
      };

      expect(mockResponse.status).toBeDefined();
      expect(mockResponse.message).toBeDefined();
      expect(mockResponse.version).toBeDefined();
      expect(mockResponse.timestamp).toBeDefined();
      expect(mockResponse.database).toBeDefined();
      expect(mockResponse.environment).toBeDefined();
    });

    it('should match StatusResponse contract', () => {
      const mockResponse: StatusResponse = {
        status: 'operational',
        version: '0.1.0',
        features: {
          semanticContent: 'planned',
          collaboration: 'planned',
          rbac: 'planned',
        },
        message: 'Ready to build the future of knowledge management!',
      };

      expect(mockResponse.status).toBeDefined();
      expect(mockResponse.version).toBeDefined();
      expect(mockResponse.features).toBeDefined();
      expect(mockResponse.message).toBeDefined();
    });

    it('should match HealthResponse contract', () => {
      const mockResponse: HealthResponse = {
        status: 'operational',
        message: 'Semiont API is running',
        version: '0.1.0',
        timestamp: '2024-01-01T00:00:00.000Z',
        database: 'connected',
        environment: 'production',
      };

      expect(mockResponse.status).toBeDefined();
      expect(mockResponse.timestamp).toBeDefined();
      expect(mockResponse.version).toBeDefined();
      expect(mockResponse.database).toBeDefined();
    });



    it('should match UserResponse contract', () => {
      const mockResponse: UserResponse = {
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
        image: 'https://example.com/avatar.jpg',
        domain: 'example.com',
        provider: 'google',
        isAdmin: false,
        isModerator: false,
        lastLogin: '2024-01-01T00:00:00.000Z',
        created: '2024-01-01T00:00:00.000Z',
        token: 'header.payload.signature',
      };

      expect(mockResponse.id).toBeDefined();
      expect(mockResponse.email).toBeDefined();
      expect(mockResponse.name).toBeDefined();
      expect(mockResponse.domain).toBeDefined();
      expect(mockResponse.provider).toBeDefined();
      expect(mockResponse.isAdmin).toBeDefined();
      expect(mockResponse.isModerator).toBeDefined();
    });

    // Logout returns 204 No Content (SDK-AUTH-CORS Phase 2) — there is no
    // response body contract to assert.

    it('should match ErrorResponse contract', () => {
      const mockResponse: ErrorResponse = {
        error: 'Something went wrong',
        details: ['Validation error 1', 'Validation error 2'],
      };

      expect(mockResponse.error).toBeDefined();
      expect(Array.isArray(mockResponse.details)).toBe(true);
    });
  });

  describe('Request/Response Flow Validation', () => {

    it('should validate error response structure', () => {
      const errorResponse: ErrorResponse = {
        error: 'Invalid request body',
        details: [
          'access_token is required',
          'access_token must be a string',
        ],
      };

      expect(errorResponse.error).toBeDefined();
      expect(Array.isArray(errorResponse.details)).toBe(true);
      expect(errorResponse.details!.length).toBeGreaterThan(0);
    });

  });

  describe('Data Validation Rules', () => {
    it('should validate email format requirements', () => {
      const validEmails = [
        'user@example.com',
        'test.user@domain.co.uk',
        'admin+test@company.org',
      ];

      const invalidEmails = [
        'not-an-email',
        '@example.com',
        'user@',
        'user.example.com',
      ];

      validEmails.forEach(email => {
        expect(email).toMatch(/\S+@\S+\.\S+/);
      });

      invalidEmails.forEach(email => {
        expect(email).not.toMatch(/\S+@\S+\.\S+/);
      });
    });

    it('should validate user ID format (UUID)', () => {
      const validUUIDs = [
        '123e4567-e89b-12d3-a456-426614174000',
        'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      ];

      const invalidUUIDs = [
        'not-a-uuid',
        '123-456-789',
        '',
        '123e4567-e89b-12d3-a456-42661417400', // too short
      ];

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      validUUIDs.forEach(uuid => {
        expect(uuid).toMatch(uuidRegex);
      });

      invalidUUIDs.forEach(uuid => {
        expect(uuid).not.toMatch(uuidRegex);
      });
    });

    it('should validate timestamp format (ISO 8601)', () => {
      const validTimestamps = [
        '2024-01-01T00:00:00.000Z',
        '2024-12-31T23:59:59.999Z',
        new Date().toISOString(),
      ];

      const invalidTimestamps = [
        '2024-01-01',
        'invalid-date',
        '2024/01/01 00:00:00',
        '',
      ];

      validTimestamps.forEach(timestamp => {
        expect(() => new Date(timestamp)).not.toThrow();
        expect(new Date(timestamp).toISOString()).toBe(timestamp);
      });

      invalidTimestamps.forEach(timestamp => {
        if (timestamp === '') {
          expect(timestamp).toBe('');
        } else {
          const date = new Date(timestamp);
          expect(isNaN(date.getTime()) || date.toISOString() !== timestamp).toBe(true);
        }
      });
    });

    it('should validate boolean fields', () => {
      const userResponse: UserResponse = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        image: null,
        domain: 'example.com',
        provider: 'google',
        isAdmin: false,
        isModerator: false,
        lastLogin: '2024-01-01T00:00:00.000Z',
        created: '2024-01-01T00:00:00.000Z',
        token: 'header.payload.signature',
      };

      expect(typeof userResponse.isAdmin).toBe('boolean');
      expect(typeof userResponse.isModerator).toBe('boolean');
    });
  });

  describe('API Resourceation Contract', () => {
    it('should validate API info structure', () => {
      const apiInfo = {
        name: 'Semiont API',
        version: '0.1.0',
        description: 'REST API for the Semiont Semantic Knowledge Platform',
        endpoints: {
          public: {
            'GET /api/hello/:name?': {
              description: 'Get a personalized greeting',
              parameters: {
                name: 'Optional name parameter',
              },
              responses: {
                200: 'HealthResponse',
              },
            },
          },
          protected: {
            'GET /api/user': {
              description: 'Get current user information',
              auth: 'Bearer token required',
              responses: {
                200: 'UserResponse',
                401: 'ErrorResponse',
              },
            },
          },
        },
      };

      expect(apiInfo.name).toBeDefined();
      expect(apiInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(apiInfo.description).toBeDefined();
      expect(apiInfo.endpoints).toBeDefined();
      expect(apiInfo.endpoints.public).toBeDefined();
      expect(apiInfo.endpoints.protected).toBeDefined();
    });
  });
});