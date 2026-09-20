import { email } from '@semiont/core';
/**
 * Integration tests for API endpoints
 * These tests make actual HTTP requests to test API functionality
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { components } from '@semiont/core';
import { loadEnvironmentConfig } from '@semiont/core/node';
import { JWTService } from '../../auth/jwt';

// Read straight off disk rather than from the __SEMIONT_VERSION__ define, so a
// build config that forgets the define is a test failure rather than a
// tautology that passes.
const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(
    resolve(fileURLToPath(import.meta.url), '../../../../package.json'),
    'utf-8',
  ),
).version;


// Delay app import until after test setup has staged the config
// Typed from the module under test rather than from a local restatement of
// its context. The copy that stood here drifted the moment the gateway's
// context changed, and `tsc` could only report that two structurally identical
// types were not the same one.
let app: typeof import('../../index').app;
// Local type definitions to replace api-contracts imports
interface HealthResponse {
  status: string;
  message: string;
  version: string;
  timestamp: string;
  database: string;
  environment: string;
}

interface OpenAPISpec {
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, unknown>;
  components: Record<string, unknown>;
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


// Derived, not restated: the spec owns this shape.
type UserResponse = components['schemas']['UserResponse'];


interface ErrorResponse {
  error: string;
  code?: string;
  details?: unknown;
}

// Local test interfaces (removed unused ApiDocResponse)


// Removed unused AdminUserUpdateResponse and AdminUserDeleteResponse interfaces


vi.mock('../../identity/principal', () => ({
  principalFromToken: vi.fn(),
}));

// Create a shared mock client that tests can modify
// Create a test user for authenticated requests
const testUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  name: 'Test User',
  image: null,
  domain: 'example.com',
  provider: 'google',
  providerId: 'google-test-user-id',
  isAdmin: false,
  isModerator: false,
  lastLogin: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Generate a test token for authenticated requests
let testToken: string;

describe('API Endpoints Integration Tests', () => {
  beforeAll(async () => {
    // Set required environment variables before importing app
    process.env.NODE_ENV = 'test';

    // Load config and initialize JWT Service.
    //
    // `null`, not SEMIONT_ROOT: the gateway mounts no knowledge base and reads
    // its whole config from ~/.semiontconfig — index.ts:48 loads exactly this
    // way. The fixture redirects HOME to its temp dir and writes the file
    // there, and `[environments.integration.site]` carries the `domain`
    // JWTService.initialize requires, so no project root is involved in reaching it.
    //
    // The SEMIONT_ROOT read this replaces outlived its requirement: both
    // gateway test setups stopped exporting the variable once nothing in
    // production read it (SINGLE-KB-MOUNT P5/P6), and the test-env hygiene
    // gate exists to stop tests fabricating deployment facts like that one.
    const config = loadEnvironmentConfig(null, 'integration');
    JWTService.initialize(config);

    // Import app after test setup has staged the config
    const serverModule = await import('../../index');
    app = serverModule.app;

    // Generate a test token
    testToken = JWTService.generateToken({      did: `did:web:${testUser.domain}:agents:test:model`,

      email: email(testUser.email),
      name: testUser.name,
      domain: testUser.domain,
    });
    
    // Resolve the test token to the test user
    const { principalFromToken } = await import('../../identity/principal');
    vi.mocked(principalFromToken).mockImplementation(async (token) => {
      if (token === testToken || token === 'valid-jwt-token') {
        return {
          did: `did:web:${testUser.domain}:users:${encodeURIComponent(testUser.email)}`,
          email: testUser.email,
          name: testUser.name,
          image: testUser.image,
          domain: testUser.domain,
          isAgent: false,
        };
      }
      throw new Error('Invalid token');
    });
  });

  describe('Protected Endpoints (Now Require Auth)', () => {
    it('GET /api/status should return 401 without auth', async () => {
      const res = await app.request('/api/status');
      expect(res.status).toBe(401);

      const data = await res.json() as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it('GET /api/status should return service status with auth', async () => {
      const res = await app.request('/api/status', {
        headers: {
          'Authorization': `Bearer ${testToken}`,
        },
      });
      expect(res.status).toBe(200);

      const data = await res.json() as StatusResponse;
      expect(data.message).toBe('Ready to build the future of knowledge management!');
      expect(data.status).toBe('operational');
      expect(data.version).toBe(PACKAGE_VERSION);
      expect(data.authenticatedAs).toBe('test@example.com');
    });



    it('GET /api/status should return 401 without auth', async () => {
      const res = await app.request('/api/status');
      expect(res.status).toBe(401);
    });

    it('GET /api/status should return status information with auth', async () => {
      const res = await app.request('/api/status', {
        headers: {
          'Authorization': `Bearer ${testToken}`,
        },
      });
      expect(res.status).toBe(200);
      
      const data = await res.json() as StatusResponse;
      expect(data.status).toBe('operational');
      expect(data.version).toBe(PACKAGE_VERSION);
      expect(data.features).toEqual({
        semanticContent: 'planned',
        collaboration: 'planned',
        rbac: 'planned',
      });
      expect(data.message).toBe('Ready to build the future of knowledge management!');
      expect(data.authenticatedAs).toBe(testUser.email);
    });
  });

  describe('Public Endpoints (No Auth Required)', () => {
    it('GET /api/health should return health status without auth', async () => {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      
      const data = await res.json() as HealthResponse;
      expect(data.status).toBe('operational');
      expect(data.message).toBe('Semiont API is running');
      expect(data.version).toBe(PACKAGE_VERSION);
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(data.environment).toBeDefined();
    });

    /*
     * "should handle database errors" stood here. The gateway has no database:
     * it reads every caller's identity off their token and holds no row, so
     * there is no connection whose failure health could report. The response
     * no longer carries a `database` field at all.
     */

    it('GET /api/openapi.json should return OpenAPI specification', async () => {
      const res = await app.request('/api/openapi.json');
      expect(res.status).toBe(200);

      const data = await res.json() as OpenAPISpec;
      expect(data.info).toBeDefined();
      expect(data.info.title).toBe('Semiont API');
      // The served spec reports the running build, not the spec file's
      // placeholder — see the info stamp in index.ts.
      expect(data.info.version).toBe(PACKAGE_VERSION);
      expect(data.paths).toBeDefined();
      expect(data.components).toBeDefined();
    });

    it('GET /api/docs should return HTML resourceation', async () => {
      const res = await app.request('/api/docs');
      expect(res.status).toBe(200);

      const html = await res.text();
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('swagger-ui');
    });
  });

  describe('Protected Endpoints', () => {
    const mockUser = {
      id: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
      image: 'https://example.com/avatar.jpg',
      domain: 'example.com',
      provider: 'google',
      providerId: 'google-123',
      isAdmin: false,
      isModerator: false,
      lastLogin: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(async () => {
      // Mock successful token verification for protected routes
      const { principalFromToken } = await import('../../identity/principal');
      vi.mocked(principalFromToken).mockImplementation(async (token) => {
        if (token === 'valid-jwt-token') {
          return {
          did: `did:web:${mockUser.domain}:users:${encodeURIComponent(mockUser.email)}`,
          email: mockUser.email,
          name: mockUser.name,
          image: mockUser.image,
          domain: mockUser.domain,
          isAgent: false,
        };
        }
        throw new Error('Invalid token');
      });
    });

    it('GET /api/users/me should return user info with valid token', async () => {
      const res = await app.request('/api/users/me', {
        headers: {
          'Authorization': 'Bearer valid-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as UserResponse;
      // The DID, not the row id: this is the name the rest of the system uses
      // for the caller, so it is the one a client can correlate against.
      expect(data.did).toBe('did:web:example.com:users:test%40example.com');
      expect(data.email).toBe('test@example.com');
      expect(data.name).toBe('Test User');
    });

    it('GET /api/users/me should fail without token', async () => {
      const res = await app.request('/api/users/me');
      expect(res.status).toBe(401);
      
      const data = await res.json() as ErrorResponse;
      expect(data.error).toBe('Unauthorized');
    });

    it('GET /api/users/me should fail with invalid token', async () => {
      const { principalFromToken } = await import('../../identity/principal');
      vi.mocked(principalFromToken).mockRejectedValue(new Error('Invalid token'));

      const res = await app.request('/api/users/me', {
        headers: {
          'Authorization': 'Bearer invalid-token',
        },
      });

      expect(res.status).toBe(401);
      const data = await res.json() as ErrorResponse;
      expect(data.error).toContain('token');
    });

  });

  describe('Error Handling', () => {
    it('should handle 404 for non-existent endpoints', async () => {
      const res = await app.request('/api/nonexistent');
      expect(res.status).toBe(404);
    });

    /**
     * Authentication happens BEFORE the body is read.
     *
     * This asserted 400 while the agent route was the one public POST. It no
     * longer is — every POST the gateway serves requires a bearer — so an
     * unauthenticated caller sending rubbish gets 401 and the body is never
     * parsed. That ordering is the property worth holding: a parser should not
     * run on input from someone who has not identified themselves.
     */
    it('authenticates before parsing a malformed request body', async () => {
      const res = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });

      expect(res.status).toBe(401);
    });

  });
});