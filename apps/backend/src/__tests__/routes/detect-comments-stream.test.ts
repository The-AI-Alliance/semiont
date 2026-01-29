/**
 * Comment Detection Stream API Tests
 *
 * Tests the HTTP contract of the POST /resources/:resourceId/detect-comments-stream endpoint.
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

describe('POST /resources/:resourceId/detect-comments-stream', () => {
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
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
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
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
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
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instructions: 'Add explanatory comments for complex concepts'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept tone parameter - scholarly', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tone: 'scholarly'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept tone parameter - explanatory', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tone: 'explanatory'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept tone parameter - conversational', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tone: 'conversational'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept tone parameter - technical', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tone: 'technical'
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept density parameter within valid range', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 6
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept minimum density value (2)', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 2
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should accept maximum density value (12)', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 12
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should reject density below minimum (1)', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 1
      }),
    });

    expect(response.status).toBe(400);
  });

  it('should reject density above maximum (13)', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        density: 13
      }),
    });

    expect(response.status).toBe(400);
  });

  it('should accept instructions, tone, and density together', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instructions: 'Explain key concepts for beginners',
        tone: 'explanatory',
        density: 8
      }),
    });

    expect(response.status).toBe(200);
  });

  it('should require authentication', async () => {
    const response = await app.request('/resources/test-resource/detect-comments-stream', {
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

    const response = await app.request('/resources/nonexistent-resource/detect-comments-stream', {
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
