/**
 * Jobs Routes
 *
 * Two route groups:
 *
 * 1. Frontend job status query:
 *    GET /api/jobs/:id
 *
 * 2. Worker reactive contract (/jobs prefix, no /api):
 *    GET  /jobs/stream?type=...   — SSE push of job-available notifications
 *    POST /jobs/:id/claim         — atomic job claim
 *    POST /jobs/:id/events        — emit domain events for a running job
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@prisma/client';
import type { Context, Next } from 'hono';
import { jobId } from '@semiont/core';
import type { EventBus, EventMap } from '@semiont/core';
import { eventBusRequest } from '../../utils/event-bus-request';

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

interface JobQueue {
  getJob(id: ReturnType<typeof jobId>): Promise<{ metadata: { type: string; userId: string }; status: string; params: unknown } | null>;
  updateJob(job: unknown, oldStatus?: string): Promise<void>;
}

export function createJobsRouter(jobQueue: JobQueue, authMiddleware: AuthMiddleware) {
  const jobsRouter = new Hono<{ Variables: { user: User; eventBus: EventBus } }>();

  // ── Worker: token exchange (unauthenticated — this IS the auth step) ─

  jobsRouter.post('/jobs/token', async (c) => {
    const workerSecret = process.env.SEMIONT_WORKER_SECRET;
    if (!workerSecret) {
      throw new HTTPException(503, { message: 'Worker authentication not configured' });
    }

    const body = await c.req.json();
    if (body.secret !== workerSecret) {
      throw new HTTPException(401, { message: 'Invalid worker secret' });
    }

    const { JWTService } = await import('../../auth/jwt');
    const token = JWTService.generateToken({
      userId: 'worker-pool' as Parameters<typeof JWTService.generateToken>[0]['userId'],
      email: 'worker@semiont.local' as Parameters<typeof JWTService.generateToken>[0]['email'],
      name: 'Worker Pool',
      domain: 'semiont.local',
      provider: 'worker',
      isAdmin: false,
    }, '24h');

    return c.json({ token });
  });

  // ── Auth middleware for all other job routes ─────────────────────────

  jobsRouter.use('/api/jobs/*', authMiddleware);
  jobsRouter.use('/jobs/stream', authMiddleware);
  jobsRouter.use('/jobs/:id/*', authMiddleware);

  // ── Frontend: job status query ──────────────────────────────────────

  jobsRouter.get('/api/jobs/:id', async (c) => {
    const { id } = c.req.param();
    const user = c.get('user');
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'job:status-requested',
        { correlationId, jobId: jobId(id) },
        'job:status-result',
        'job:status-failed',
      );

      if (response.userId !== user.id) {
        throw new HTTPException(404, { message: 'Job not found' });
      }

      return c.json(response);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof Error) {
        if (error.message === 'Job not found') {
          throw new HTTPException(404, { message: 'Job not found' });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Request timed out' });
        }
      }
      throw error;
    }
  });

  // ── Worker: SSE job stream (KS → worker) ───────────────────────────

  jobsRouter.get('/jobs/stream', (c) => {
    const typeParam = c.req.queries('type') ?? [];
    const typeSet = new Set(typeParam);
    const eventBus = c.get('eventBus');

    return streamSSE(c, async (stream) => {
      const sub = eventBus.get('job:queued').subscribe((event) => {
        const jobType = (event as { type?: string; payload?: { jobType?: string } }).payload?.jobType
          ?? (event as { metadata?: { type?: string } }).metadata?.type;
        if (typeSet.size > 0 && jobType && !typeSet.has(jobType)) return;

        stream.writeSSE({
          event: 'job-available',
          data: JSON.stringify({
            jobId: (event as { jobId?: string; payload?: { jobId?: string } }).payload?.jobId ?? (event as { jobId?: string }).jobId,
            type: jobType,
            resourceId: (event as { resourceId?: string }).resourceId,
          }),
        }).catch(() => {});
      });

      stream.onAbort(() => sub.unsubscribe());

      while (true) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(15_000);
      }
    });
  });

  // ── Worker: atomic job claim ────────────────────────────────────────

  jobsRouter.post('/jobs/:id/claim', async (c) => {
    const { id } = c.req.param();
    const jid = jobId(id);

    const job = await jobQueue.getJob(jid) as {
      metadata: { type: string; userId: string; jobId: string };
      status: string;
      params: unknown;
    } | null;

    if (!job) {
      throw new HTTPException(404, { message: 'Job not found' });
    }

    if (job.status !== 'pending') {
      throw new HTTPException(409, { message: 'Job already claimed' });
    }

    const runningJob = {
      ...job,
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: {},
    };

    await jobQueue.updateJob(runningJob, 'pending');

    return c.json(runningJob);
  });

  // ── Worker: emit domain events for a running job ────────────────────

  jobsRouter.post('/jobs/:id/events', async (c) => {
    const eventBus = c.get('eventBus');
    const payload = await c.req.json();
    const { type, resourceId, ...rest } = payload;

    if (!type) {
      throw new HTTPException(400, { message: 'Event type is required' });
    }

    const channel = eventBus.get(type as keyof EventMap);
    if (!channel) {
      throw new HTTPException(400, { message: `Unknown event type: ${type}` });
    }

    channel.next({ ...rest, resourceId, type } as never);

    return c.json(null, 202);
  });

  return jobsRouter;
}
