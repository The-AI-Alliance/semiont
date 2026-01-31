/**
 * Assessment Detection Stream API Tests
 *
 * Tests the HTTP contract of the POST /resources/:resourceId/detect-assessments-stream endpoint.
 * Focuses on parameter validation, authentication, and response format.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { userId } from '@semiont/core';
import { email } from '@semiont/api-client';
import { JWTService } from '../../auth/jwt';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig } from '@semiont/core';

type Variables = {
  user: User;
  config: EnvironmentConfig;
  makeMeaning: any;
};

// Mock entire @semiont/make-meaning with simple mocks
const mockJobQueue = {
  createJob: vi.fn().mockResolvedValue({ id: 'job-123' }),
  getJob: vi.fn(),
  listJobs: vi.fn(),
};

const mockResourceMetadata = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  '@id': 'urn:semiont:resource:test-resource',
  '@type': 'ResourceDescriptor',
  name: 'Test Resource',
  representations: [{
    mediaType: 'text/plain',
    rel: 'original',
    checksum: 'abc123'
  }]
};

vi.mock('@semiont/make-meaning', () => ({
  ResourceContext: {
    getResourceMetadata: vi.fn().mockResolvedValue(mockResourceMetadata)
  },
  AnnotationContext: {
    buildLLMContext: vi.fn().mockResolvedValue({
    getAllAnnotations: vi.fn().mockResolvedValue([])
      sourceContext: null,
      targetContext: null
    })
  },
  startMakeMeaning: vi.fn().mockResolvedValue({
    jobQueue: mockJobQueue,
    workers: [],
    graphConsumer: {}
  })
}));

// Mock database
vi.mock('../../db', () => ({
  DatabaseConnection: {
    getClient: vi.fn(() => ({
      user: {
        findUnique: vi.fn(),
      },
    })),
  },
}));

// Mock OAuth
vi.mock('../../auth/oauth', () => ({
  OAuthService: {
    getUserFromToken: vi.fn(),
  },
}));

describe('POST /resources/:resourceId/detect-assessments-stream', () => {
  let app: Hono<{ Variables: Variables }>;
  let authToken: string;
  const testUser = {
    id: 'test-user-id',
    email: 'test@test.local',
    domain: 'test.local',
    provider: 'oauth',
    isAdmin: false,
    name: 'Test User',
  };

  beforeAll(async () => {
    // Initialize JWTService
    const mockConfig: EnvironmentConfig = {
      site: {
        domain: 'test.local',
        oauthAllowedDomains: ['test.local'],
      },
      services: {
        backend: {
          publicURL: 'http://localhost:4000',
          platform: { type: 'posix' },
          port: 4000,
          corsOrigin: '*',
          jwtSecret: 'test-secret-key-at-least-32-characters-long',
        },
      },
    } as EnvironmentConfig;
    JWTService.initialize(mockConfig);

    // Create auth token
    const tokenPayload = {
      userId: userId(testUser.id),
      email: email(testUser.email),
      domain: testUser.domain,
      provider: testUser.provider,
      isAdmin: testUser.isAdmin,
      name: testUser.name || undefined,
    };
    authToken = JWTService.generateToken(tokenPayload);

    // Mock database user lookup
    const { DatabaseConnection } = await import('../../db');
    const prisma = DatabaseConnection.getClient();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(testUser as any);

    // Mock OAuth service
    const { OAuthService } = await import('../../auth/oauth');
    vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) => {
      return token === authToken ? (testUser as any) : null;
    });

    // Import app after mocks are set up
    const { app: importedApp } = await import('../../index');
    app = importedApp;
  });

  it('should return SSE stream with proper content-type', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
  });

  it('should accept detection without parameters', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
  });

  it('should accept instructions parameter', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instructions: 'Assess the validity of scientific claims'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept tone parameter - analytical', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tone: 'analytical'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept tone parameter - critical', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tone: 'critical'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept tone parameter - balanced', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tone: 'balanced'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept tone parameter - constructive', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tone: 'constructive'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept density parameter within valid range', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 5
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept minimum density value (1)', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 1
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept maximum density value (10)', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 10
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should reject density below minimum (0)', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 0
      }),
    });

    expect(response.status).toBe(400);
  });

  it('should reject density above maximum (11)', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 11
      }),
    });

    expect(response.status).toBe(400);
  });

  it('should accept instructions, tone, and density together', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instructions: 'Evaluate methodological rigor',
        tone: 'balanced',
        density: 6
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should require authentication', async () => {
    const response = await app.request('/resources/test-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });

  it('should handle resource not found', async () => {
    // Override mock for this test
    const { ResourceContext } = await import('@semiont/make-meaning');
    vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValueOnce(null);

    const response = await app.request('/resources/nonexistent-resource/detect-assessments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
  });
});
