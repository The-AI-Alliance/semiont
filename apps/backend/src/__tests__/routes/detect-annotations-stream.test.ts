/**
 * Detect Annotations Stream SSE Endpoint Tests
 *
 * Tests the event-driven SSE endpoint that subscribes to Event Store
 * for real-time detection progress updates.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import { JWTService } from '../../auth/jwt';
import { initializeJobQueue, getJobQueue } from '../../jobs/job-queue';
import { EventStore } from '../../events/event-store';
import { FilesystemProjectionStorage } from '../../storage/projection-storage';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Variables = {
  user: User;
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
  getFilesystemConfig: () => ({ path: testDir })
}));

let app: Hono<{ Variables: Variables }>;

describe('POST /api/resources/:id/detect-annotations-stream - Event Store Subscriptions', () => {
  let authToken: string;
  let testUser: User;
  // @ts-ignore - used in multiple test blocks
  let eventStore: EventStore;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-sse-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Set required environment variables
    process.env.SITE_DOMAIN = 'test.example.com';
    process.env.OAUTH_ALLOWED_DOMAINS = 'test.example.com,example.com';
    process.env.JWT_SECRET = 'test-secret-key-for-testing-with-at-least-32-characters';
    process.env.BACKEND_URL = 'http://localhost:4000';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    process.env.FRONTEND_URL = 'http://localhost:3000';
    process.env.NODE_ENV = 'test';

    // Initialize job queue
    await initializeJobQueue({ dataDir: join(testDir, 'jobs') });

    // Initialize Event Store
    const projectionStorage = new FilesystemProjectionStorage(testDir);
    eventStore = new EventStore({
      basePath: testDir,
      dataDir: testDir,
      enableSharding: false,
      maxEventsPerFile: 100,
    }, projectionStorage);

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
      isAdmin: false,
      isModerator: false,
      isActive: true,
      termsAcceptedAt: new Date(),
      lastLogin: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const tokenPayload = {
      userId: testUser.id,
      email: testUser.email,
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
  });

  it('should return SSE stream with proper content-type', async () => {
    const response = await app.request('/api/resources/test-resource/detect-annotations-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        entityTypes: ['Person']
      }),
    });

    const contentType = response.headers.get('content-type');
    // SSE streams should have text/event-stream content type (with or without charset)
    expect(contentType).toMatch(/text\/event-stream/);
  });

  it('should create a job when SSE connection is established', async () => {
    const jobQueue = getJobQueue();
    const jobsBefore = await jobQueue.listJobs();
    const countBefore = jobsBefore.length;

    await app.request('/api/resources/test-resource/detect-annotations-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        entityTypes: ['Person', 'Organization']
      }),
    });

    const jobsAfter = await jobQueue.listJobs();
    expect(jobsAfter.length).toBeGreaterThan(countBefore);

    const newJob = jobsAfter.find(j => !jobsBefore.some(old => old.id === j.id));
    expect(newJob).toBeDefined();
    expect(newJob?.type).toBe('detection');
  });

  it('should send detection-started event immediately', async () => {
    const response = await app.request('/api/resources/test-resource/detect-annotations-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        entityTypes: ['Person']
      }),
    });

    expect(response.status).toBe(200);
    // Note: In a real test, we'd parse the SSE stream and check for the 'detection-started' event
    // This is a basic check that the endpoint responds correctly
  });

  it('should require authentication', async () => {
    const response = await app.request('/api/resources/test-resource/detect-annotations-stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        entityTypes: ['Person']
      }),
    });

    expect(response.status).toBe(401);
  });

  it('should validate request body has entityTypes', async () => {
    const response = await app.request('/api/resources/test-resource/detect-annotations-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}), // Missing entityTypes
    });

    expect(response.status).toBe(400);
  });

  it('should handle resource not found', async () => {
    // Mock ResourceQueryService to return null
    const { ResourceQueryService } = await import('../../services/resource-queries');
    vi.mocked(ResourceQueryService.getResourceMetadata).mockResolvedValueOnce(null);

    const response = await app.request('/api/resources/nonexistent-resource/detect-annotations-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        entityTypes: ['Person']
      }),
    });

    expect(response.status).toBe(404);
  });
});

describe('Event Store Subscription Pattern', () => {
  let eventStore: EventStore;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-subscription-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const projectionStorage = new FilesystemProjectionStorage(testDir);
    eventStore = new EventStore({
      basePath: testDir,
      dataDir: testDir,
      enableSharding: false,
      maxEventsPerFile: 100,
    }, projectionStorage);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should subscribe to resource events and receive job.progress events', async () => {
    const resourceId = 'test-resource-1';
    const receivedEvents: any[] = [];

    const subscription = eventStore.subscriptions.subscribe(resourceId, async (storedEvent: any) => {
      receivedEvents.push(storedEvent.event);
    });

    // Emit a job.progress event
    await eventStore.appendEvent({
      type: 'job.progress',
      resourceId,
      userId: 'user-1',
      version: 1,
      payload: {
        jobId: 'job-1',
        jobType: 'detection',
        percentage: 50,
        currentStep: 'Person',
        processedSteps: 1,
        totalSteps: 2,
        message: 'Scanning for Person...'
      }
    });

    // Wait for async notification
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].type).toBe('job.progress');
    expect(receivedEvents[0].payload.jobId).toBe('job-1');

    subscription.unsubscribe();
  });

  it('should receive job.completed event', async () => {
    const resourceId = 'test-resource-2';
    const receivedEvents: any[] = [];

    const subscription = eventStore.subscriptions.subscribe(resourceId, async (storedEvent: any) => {
      receivedEvents.push(storedEvent.event);
    });

    await eventStore.appendEvent({
      type: 'job.completed',
      resourceId,
      userId: 'user-1',
      version: 1,
      payload: {
        jobId: 'job-2',
        jobType: 'detection',
        message: 'Detection complete!'
      }
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].type).toBe('job.completed');

    subscription.unsubscribe();
  });

  it('should receive job.failed event', async () => {
    const resourceId = 'test-resource-3';
    const receivedEvents: any[] = [];

    const subscription = eventStore.subscriptions.subscribe(resourceId, async (storedEvent: any) => {
      receivedEvents.push(storedEvent.event);
    });

    await eventStore.appendEvent({
      type: 'job.failed',
      resourceId,
      userId: 'user-1',
      version: 1,
      payload: {
        jobId: 'job-3',
        jobType: 'detection',
        error: 'Test error',
        details: 'Test error details'
      }
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].type).toBe('job.failed');
    expect(receivedEvents[0].payload.error).toBe('Test error');

    subscription.unsubscribe();
  });

  it('should unsubscribe and stop receiving events', async () => {
    const resourceId = 'test-resource-4';
    const receivedEvents: any[] = [];

    const subscription = eventStore.subscriptions.subscribe(resourceId, async (storedEvent: any) => {
      receivedEvents.push(storedEvent.event);
    });

    // Unsubscribe immediately
    subscription.unsubscribe();

    // Emit event after unsubscribing
    await eventStore.appendEvent({
      type: 'job.progress',
      resourceId,
      userId: 'user-1',
      version: 1,
      payload: {
        jobId: 'job-4',
        jobType: 'detection',
        percentage: 50
      }
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Should not receive any events
    expect(receivedEvents).toHaveLength(0);
  });
});
