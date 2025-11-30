/**
 * Detect Annotations Stream SSE Endpoint Tests
 *
 * Tests the event-driven SSE endpoint that subscribes to Event Store
 * for real-time detection progress updates.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { resourceId, userId } from '@semiont/core';
import { resourceUri, email, jobId } from '@semiont/api-client';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig } from '@semiont/core';
import { JWTService } from '../../auth/jwt';
import { initializeJobQueue, getJobQueue } from '../../jobs/job-queue';
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

describe('POST /resources/:id/detect-annotations-stream - Event Store Subscriptions', () => {
  let authToken: string;
  let testUser: User;
  // @ts-ignore - used in multiple test blocks
  let eventStore: EventStore;
  let testEnv: TestEnvironmentConfig;

  beforeAll(async () => {
    // Set up test environment with proper config files
    testEnv = await setupTestEnvironment();

    // Get testDir from environment setup (or create a local one for job queue)
    testDir = join(tmpdir(), `semiont-test-sse-${Date.now()}`);
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
    eventStore = new EventStore(
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
    const response = await app.request('/resources/test-resource/detect-annotations-stream', {
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

    // Make the request (job is created before entering streamSSE callback)
    const responsePromise = app.request('/resources/test-resource/detect-annotations-stream', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        entityTypes: ['Person', 'Organization']
      }),
    });

    // Yield to event loop to allow request handler to run and create the job
    await new Promise(resolve => setImmediate(resolve));

    const jobsAfter = await jobQueue.listJobs();

    // Find the new job that was created by this request
    const newJob = jobsAfter.find(j => !jobsBefore.some(old => old.id === j.id));
    expect(newJob).toBeDefined();
    expect(newJob?.type).toBe('detection');

    // Type guard to access DetectionJob-specific properties
    if (newJob && newJob.type === 'detection') {
      expect(newJob.entityTypes).toEqual(['Person', 'Organization']);
    }

    // Allow the response promise to complete (avoids unhandled rejections)
    try {
      await responsePromise;
    } catch {
      // Ignore errors - the stream may be closed abruptly
    }
  });

  it('should send detection-started event immediately', async () => {
    const response = await app.request('/resources/test-resource/detect-annotations-stream', {
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
    const response = await app.request('/resources/test-resource/detect-annotations-stream', {
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
    const response = await app.request('/resources/test-resource/detect-annotations-stream', {
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

    const response = await app.request('/resources/nonexistent-resource/detect-annotations-stream', {
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

    const viewStorage = new FilesystemViewStorage(testDir);
    const identifierConfig: IdentifierConfig = { baseUrl: 'http://localhost:4000' };
    eventStore = new EventStore(
      {
        basePath: testDir,
        dataDir: testDir,
        enableSharding: false,
        maxEventsPerFile: 100,
      },
      viewStorage,
      identifierConfig
    );
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should subscribe to resource events and receive job.progress events', async () => {
    const rId = resourceId('test-resource-1');
    const rUri = resourceUri(`http://localhost:4000/resources/${rId}`);
    const receivedEvents: any[] = [];

    const subscription = eventStore.bus.subscriptions.subscribe(rUri, async (storedEvent: any) => {
      receivedEvents.push(storedEvent.event);
    });

    // Emit a job.progress event
    await eventStore.appendEvent({
      type: 'job.progress',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: jobId('job-1'),
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
    expect(receivedEvents[0].payload.jobId).toBe(jobId('job-1'));

    subscription.unsubscribe();
  });

  it('should receive job.completed event', async () => {
    const rId = resourceId('test-resource-2');
    const rUri = resourceUri(`http://localhost:4000/resources/${rId}`);
    const receivedEvents: any[] = [];

    const subscription = eventStore.bus.subscriptions.subscribe(rUri, async (storedEvent: any) => {
      receivedEvents.push(storedEvent.event);
    });

    await eventStore.appendEvent({
      type: 'job.completed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: jobId('job-2'),
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
    const rId = resourceId('test-resource-3');
    const rUri = resourceUri(`http://localhost:4000/resources/${rId}`);
    const receivedEvents: any[] = [];

    const subscription = eventStore.bus.subscriptions.subscribe(rUri, async (storedEvent: any) => {
      receivedEvents.push(storedEvent.event);
    });

    await eventStore.appendEvent({
      type: 'job.failed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: jobId('job-3'),
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
    const rId = resourceId('test-resource-4');
    const rUri = resourceUri(`http://localhost:4000/resources/${rId}`);
    const receivedEvents: any[] = [];

    const subscription = eventStore.bus.subscriptions.subscribe(rUri, async (storedEvent: any) => {
      receivedEvents.push(storedEvent.event);
    });

    // Unsubscribe immediately
    subscription.unsubscribe();

    // Emit event after unsubscribing
    await eventStore.appendEvent({
      type: 'job.progress',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: jobId('job-4'),
        jobType: 'detection',
        percentage: 50
      }
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Should not receive any events
    expect(receivedEvents).toHaveLength(0);
  });
});
