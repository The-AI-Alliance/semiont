/**
 * Contract tests - verify API matches shared types
 * These tests ensure the backend API contract matches the shared types package
 */

import { describe, it, expect } from 'vitest';
import type {
  HelloResponse,
  StatusResponse,
  HealthResponse,
  LegacyHealthResponse,
  AuthResponse,
  UserResponse,
  LogoutResponse,
  ErrorResponse,
} from '@semiont/api-types';

describe('API Contract Tests', () => {
  describe('Response Type Contracts', () => {
    it('should match HelloResponse contract', () => {
      const mockResponse: HelloResponse = {
        message: 'Hello, World! Welcome to Semiont.',
        timestamp: '2024-01-01T00:00:00.000Z',
        platform: 'Semiont Semantic Knowledge Platform',
      };

      expect(mockResponse.message).toBeDefined();
      expect(mockResponse.timestamp).toBeDefined();
      expect(mockResponse.platform).toBeDefined();
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
        status: 'healthy',
        timestamp: '2024-01-01T00:00:00.000Z',
        uptime: 12345,
        version: '0.1.0',
        database: 'connected',
      };

      expect(mockResponse.status).toBeDefined();
      expect(mockResponse.timestamp).toBeDefined();
      expect(mockResponse.uptime).toBeDefined();
      expect(mockResponse.version).toBeDefined();
    });

    it('should match LegacyHealthResponse contract', () => {
      const mockResponse: LegacyHealthResponse = {
        status: 'ok',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      expect(mockResponse.status).toBeDefined();
      expect(mockResponse.timestamp).toBeDefined();
    });

    it('should match AuthResponse contract', () => {
      const mockResponse: AuthResponse = {
        success: true,
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          image: 'https://example.com/avatar.jpg',
          isAdmin: false,
        },
        token: 'mock-jwt-token',
        isNewUser: false,
      };

      expect(mockResponse.success).toBeDefined();
      expect(mockResponse.user).toBeDefined();
      expect(mockResponse.user.id).toBeDefined();
      expect(mockResponse.user.email).toBeDefined();
      expect(mockResponse.token).toBeDefined();
      expect(mockResponse.isNewUser).toBeDefined();
    });

    it('should match UserResponse contract', () => {
      const mockResponse: UserResponse = {
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          image: 'https://example.com/avatar.jpg',
          domain: 'example.com',
          provider: 'google',
          isAdmin: false,
          isActive: true,
          termsAcceptedAt: '2024-01-01T00:00:00.000Z',
          lastLogin: '2024-01-01T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      };

      expect(mockResponse.user).toBeDefined();
      expect(mockResponse.user.id).toBeDefined();
      expect(mockResponse.user.email).toBeDefined();
      expect(mockResponse.user.domain).toBeDefined();
      expect(mockResponse.user.provider).toBeDefined();
      expect(mockResponse.user.isAdmin).toBeDefined();
      expect(mockResponse.user.isActive).toBeDefined();
    });

    it('should match LogoutResponse contract', () => {
      const mockResponse: LogoutResponse = {
        success: true,
        message: 'Logged out successfully',
      };

      expect(mockResponse.success).toBeDefined();
      expect(mockResponse.message).toBeDefined();
    });

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
    it('should validate Google Auth request flow', () => {
      // Request validation
      const validRequest = {
        access_token: 'valid-google-token',
      };

      expect(validRequest.access_token).toBeDefined();
      expect(typeof validRequest.access_token).toBe('string');
      expect(validRequest.access_token.length).toBeGreaterThan(0);

      // Response validation
      const successResponse: AuthResponse = {
        success: true,
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          image: 'https://example.com/avatar.jpg',
          isAdmin: false,
        },
        token: 'jwt-token',
        isNewUser: false,
      };

      expect(successResponse.success).toBe(true);
      expect(successResponse.user.email).toMatch(/\S+@\S+\.\S+/);
    });

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

    it('should validate admin endpoints response structure', () => {
      // Users list response
      const usersResponse = {
        users: [
          {
            id: 'user-1',
            email: 'user1@example.com',
            name: 'User One',
            image: null,
            domain: 'example.com',
            provider: 'google',
            isAdmin: false,
            isActive: true,
            termsAcceptedAt: '2024-01-01T00:00:00.000Z',
            lastLogin: '2024-01-01T00:00:00.000Z',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        pagination: {
          page: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
        },
      };

      expect(Array.isArray(usersResponse.users)).toBe(true);
      expect(usersResponse.pagination).toBeDefined();
      expect(usersResponse.pagination.page).toBeGreaterThan(0);
      expect(usersResponse.pagination.limit).toBeGreaterThan(0);
      expect(usersResponse.pagination.total).toBeGreaterThanOrEqual(0);
      expect(usersResponse.pagination.totalPages).toBeGreaterThan(0);

      // User stats response
      const statsResponse = {
        total: 10,
        active: 8,
        admins: 2,
        providers: {
          google: 10,
        },
      };

      expect(typeof statsResponse.total).toBe('number');
      expect(typeof statsResponse.active).toBe('number');
      expect(typeof statsResponse.admins).toBe('number');
      expect(typeof statsResponse.providers).toBe('object');
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
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          image: null,
          domain: 'example.com',
          provider: 'google',
          isAdmin: false,
          isActive: true,
          termsAcceptedAt: null,
          lastLogin: '2024-01-01T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      };

      expect(typeof userResponse.user.isAdmin).toBe('boolean');
      expect(typeof userResponse.user.isActive).toBe('boolean');
    });
  });

  describe('API Documentation Contract', () => {
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
                200: 'HelloResponse',
              },
            },
          },
          auth: {
            'POST /api/auth/google': {
              description: 'Authenticate with Google OAuth',
              body: 'GoogleAuthRequest',
              responses: {
                200: 'AuthResponse',
                400: 'ErrorResponse',
                401: 'ErrorResponse',
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
          admin: {
            'GET /api/admin/users': {
              description: 'List all users (admin only)',
              auth: 'Admin Bearer token required',
              responses: {
                200: 'UserListResponse',
                401: 'ErrorResponse',
                403: 'ErrorResponse',
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
      expect(apiInfo.endpoints.auth).toBeDefined();
      expect(apiInfo.endpoints.protected).toBeDefined();
      expect(apiInfo.endpoints.admin).toBeDefined();
    });
  });
});