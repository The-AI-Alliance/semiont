/**
 * Detect Comments Stream SSE Endpoint Tests
 *
 * Tests the comment detection endpoint with tone and density parameter support.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { userId } from '@semiont/core';
import { email } from '@semiont/api-client';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig } from '@semiont/core';
import { JWTService } from '../../auth/jwt';
import { initializeJobQueue } from '../../jobs/job-queue';
import { EventStore } from '../../events/event-store';
import type { IdentifierConfig } from '../../services/identifier-service';
import { FilesystemViewStorage } from '../../storage/view-storage';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../_test-setup';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Variables = {
  user: User;
  config: EnvironmentConfig;
};

let testDir: string;

// Create shared mock Prisma client
const sharedMockClient = {
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  $queryRaw: vi.fn(),
} as any;

// Mock the entire auth/oauth module
vi.mock('../../auth/oauth', () => ({
  OAuthService: {
    verifyGoogleToken: vi.fn(),
    createOrUpdateUser: vi.fn(),
    getUserFromToken: vi.fn(),
    acceptTerms: vi.fn(),
  },
}));

// Mock database
vi.mock('../../db', () => ({
  DatabaseConnection: {
    getClient: vi.fn(() => sharedMockClient),
    checkHealth: vi.fn().mockResolvedValue(true),
  },
  prisma: sharedMockClient,
}));

// Mock ResourceQueryService
vi.mock('../../services/resource-queries', () => ({
  ResourceQueryService: {
    getResourceMetadata: vi.fn().mockResolvedValue({
      id: 'test-resource',
      name: 'Test Resource',
      format: 'text/plain'
    })
  },
}));

// Mock environment
vi.mock('../../config/environment-loader', () => ({
  getFilesystemConfig: () => ({ path: testDir }),
  getBackendConfig: () => ({ publicURL: 'http://localhost:4000' })
}));

let app: Hono<{ Variables: Variables }>;

describe('POST /resources/:id/detect-comments-stream', () => {
  let authToken: string;
  let testUser: User;
  let testEnv: TestEnvironmentConfig;

  beforeAll(async () => {
    // Set up test environment with proper config files
    testEnv = await setupTestEnvironment();

    // Get testDir from environment setup (or create a local one for job queue)
    testDir = join(tmpdir(), `semiont-test-comments-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Set additional JWT environment variables
    process.env.SITE_DOMAIN = 'test.example.com';
    process.env.OAUTH_ALLOWED_DOMAINS = 'test.example.com,example.com';
    process.env.JWT_SECRET = 'test-secret-key-for-testing-with-at-least-32-characters';

    // Initialize JWTService with test config
    JWTService.initialize(testEnv.config);

    // Initialize job queue
    await initializeJobQueue({ dataDir: join(testDir, 'jobs') });

    // Initialize Event Store
    const viewStorage = new FilesystemViewStorage(testDir);
    const identifierConfig: IdentifierConfig = { baseUrl: 'http://localhost:4000' };
    new EventStore(
      {
        basePath: testDir,
        dataDir: testDir,
        enableSharding: false,
        maxEventsPerFile: 100,
      },
      viewStorage,
      identifierConfig
    );

    // Import app after environment setup
    const appModule = await import('../../index');
    app = appModule.app;

    // Create test user and token
    testUser = {
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
      image: null,
      domain: 'example.com',
      provider: 'google',
      providerId: 'google-123',
      passwordHash: null,
      isAdmin: false,
      isModerator: false,
      isActive: true,
      termsAcceptedAt: new Date(),
      lastLogin: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const tokenPayload = {
      userId: userId(testUser.id),
      email: email(testUser.email),
      domain: testUser.domain,
      provider: testUser.provider,
      isAdmin: testUser.isAdmin,
      name: testUser.name || undefined,
    };

    authToken = JWTService.generateToken(tokenPayload);

    // Mock the database
    const { DatabaseConnection } = await import('../../db');
    const prisma = DatabaseConnection.getClient();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(testUser as any);

    // Mock OAuthService
    const { OAuthService } = await import('../../auth/oauth');
    vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) => {
      if (token === authToken) {
        return testUser as any;
      }
      return null;
    });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    await testEnv.cleanup();
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

    const contentType = response.headers.get('content-type');
    expect(contentType).toMatch(/text\/event-stream/);
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
    // Mock ResourceQueryService to return null
    const { ResourceQueryService } = await import('../../services/resource-queries');
    vi.mocked(ResourceQueryService.getResourceMetadata).mockResolvedValueOnce(null);

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
