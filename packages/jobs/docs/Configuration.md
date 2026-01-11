# Configuration Guide

This guide covers how to configure and deploy the @semiont/jobs package in different environments.

## Table of Contents

- [Basic Configuration](#basic-configuration)
- [Directory Structure](#directory-structure)
- [Worker Configuration](#worker-configuration)
- [Development Setup](#development-setup)
- [Production Setup](#production-setup)
- [Environment Variables](#environment-variables)
- [Scaling Strategies](#scaling-strategies)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## Basic Configuration

### Minimal Setup

```typescript
import { initializeJobQueue } from '@semiont/jobs';

// Initialize with data directory
await initializeJobQueue({
  dataDir: './data'
});
```

### With Custom Path

```typescript
import { initializeJobQueue } from '@semiont/jobs';
import * as path from 'path';

// Use absolute path
await initializeJobQueue({
  dataDir: path.resolve(process.cwd(), 'data')
});

// Use environment variable
await initializeJobQueue({
  dataDir: process.env.DATA_DIR || './data'
});
```

### JobQueueConfig Interface

```typescript
interface JobQueueConfig {
  dataDir: string;  // Base directory for job storage
}
```

Jobs will be stored in `{dataDir}/jobs/` with subdirectories for each status.

## Directory Structure

### Default Structure

```
data/
  jobs/
    pending/        # Jobs waiting to be processed
    running/        # Jobs currently being processed
    complete/       # Successfully completed jobs
    failed/         # Failed jobs with error details
    cancelled/      # User-cancelled jobs
```

### Permission Requirements

The application needs read/write access to the data directory:

```bash
# Set appropriate permissions (Linux/macOS)
chmod 755 data/
chmod 755 data/jobs/
chmod 755 data/jobs/pending/
chmod 755 data/jobs/running/
# ... etc
```

### Docker Volumes

```yaml
# docker-compose.yml
services:
  app:
    image: my-app
    volumes:
      - ./data:/app/data  # Mount data directory
    environment:
      DATA_DIR: /app/data
```

### Shared Filesystem

For multiple workers:

```yaml
# docker-compose.yml with shared volume
services:
  worker-1:
    image: my-worker
    volumes:
      - jobs-data:/app/data  # Shared volume

  worker-2:
    image: my-worker
    volumes:
      - jobs-data:/app/data  # Same shared volume

volumes:
  jobs-data:  # Named volume
```

## Worker Configuration

### Poll Interval

```typescript
import { JobWorker } from '@semiont/jobs';

class MyWorker extends JobWorker {
  constructor() {
    super(
      1000,  // pollIntervalMs: check queue every 1 second
      5000   // errorBackoffMs: wait 5 seconds after errors
    );
  }
}
```

**Recommendations:**
- High-frequency queue (>10 jobs/min): 500ms - 1000ms
- Normal queue (1-10 jobs/min): 1000ms - 2000ms
- Low-frequency queue (<1 job/min): 5000ms - 10000ms

### Error Backoff

```typescript
class ResilientWorker extends JobWorker {
  constructor() {
    super(
      1000,   // Normal polling
      30000   // 30 second backoff after errors
    );
  }
}
```

**When to increase backoff:**
- External service rate limits
- Temporary infrastructure issues
- High error rates

## Development Setup

### Single Process

```typescript
// server.ts
import { initializeJobQueue } from '@semiont/jobs';
import { GenerationWorker } from './workers/generation-worker';

async function main() {
  // Initialize queue
  await initializeJobQueue({ dataDir: './data' });

  // Start worker in same process
  const worker = new GenerationWorker();
  worker.start(); // Don't await - runs in background

  // Start HTTP server
  const app = createApp();
  app.listen(3000);
}

main();
```

### Separate Worker Process

```typescript
// server.ts
await initializeJobQueue({ dataDir: './data' });
// Just create jobs, don't start workers

// worker.ts
await initializeJobQueue({ dataDir: './data' });
const worker = new GenerationWorker();
await worker.start(); // This process only runs workers
```

Run separately:

```bash
# Terminal 1: HTTP server
npm run dev

# Terminal 2: Worker
npm run worker
```

### Docker Compose for Development

```yaml
# docker-compose.dev.yml
services:
  app:
    build: .
    command: npm run dev
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./src:/app/src  # Hot reload
    environment:
      DATA_DIR: /app/data
      NODE_ENV: development

  worker:
    build: .
    command: npm run worker
    volumes:
      - ./data:/app/data
      - ./src:/app/src  # Hot reload
    environment:
      DATA_DIR: /app/data
      NODE_ENV: development
```

## Production Setup

### Environment Variables

```bash
# .env.production
DATA_DIR=/var/lib/myapp/data
NODE_ENV=production
WORKER_POLL_INTERVAL=1000
WORKER_ERROR_BACKOFF=5000
CLEANUP_INTERVAL=3600000  # 1 hour
CLEANUP_AGE=86400000      # 1 day
```

### Configuration Service

```typescript
// config.ts
export interface AppConfig {
  dataDir: string;
  worker: {
    pollIntervalMs: number;
    errorBackoffMs: number;
  };
  cleanup: {
    intervalMs: number;
    ageMs: number;
  };
}

export function loadConfig(): AppConfig {
  return {
    dataDir: process.env.DATA_DIR || './data',
    worker: {
      pollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL || '1000'),
      errorBackoffMs: parseInt(process.env.WORKER_ERROR_BACKOFF || '5000'),
    },
    cleanup: {
      intervalMs: parseInt(process.env.CLEANUP_INTERVAL || '3600000'),
      ageMs: parseInt(process.env.CLEANUP_AGE || '86400000'),
    },
  };
}
```

### Graceful Shutdown

```typescript
// worker.ts
import { GenerationWorker } from './workers/generation-worker';

const workers: JobWorker[] = [];

async function startWorkers() {
  const generationWorker = new GenerationWorker();
  const detectionWorker = new DetectionWorker();

  workers.push(generationWorker, detectionWorker);

  // Start all workers
  await Promise.all(workers.map(w => w.start()));
}

// Handle shutdown signals
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, stopping workers...');
  await stopWorkers();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, stopping workers...');
  await stopWorkers();
  process.exit(0);
});

async function stopWorkers() {
  await Promise.all(workers.map(w => w.stop()));
}

startWorkers();
```

### Health Checks

```typescript
// health.ts
import { getJobQueue } from '@semiont/jobs';

export async function healthCheck(): Promise<boolean> {
  try {
    const queue = getJobQueue();

    // Check queue is accessible
    await queue.queryJobs({ status: 'pending' });

    return true;
  } catch (error) {
    console.error('[Health] Queue check failed:', error);
    return false;
  }
}

// HTTP endpoint
app.get('/health', async (req, res) => {
  const healthy = await healthCheck();
  res.status(healthy ? 200 : 503).json({ healthy });
});
```

### Periodic Cleanup

```typescript
// cleanup.ts
import { getJobQueue } from '@semiont/jobs';

export function startCleanup(config: AppConfig) {
  setInterval(async () => {
    try {
      const queue = getJobQueue();
      const olderThan = Date.now() - config.cleanup.ageMs;

      const removed = await queue.cleanupCompletedJobs(olderThan);

      console.log(`[Cleanup] Removed ${removed} old jobs`);
    } catch (error) {
      console.error('[Cleanup] Failed:', error);
    }
  }, config.cleanup.intervalMs);
}

// In main
startCleanup(config);
```

## Environment Variables

### Standard Variables

```bash
# Data directory
DATA_DIR=/var/lib/myapp/data

# Node environment
NODE_ENV=production

# Worker configuration
WORKER_POLL_INTERVAL=1000    # Poll every 1 second
WORKER_ERROR_BACKOFF=5000    # Wait 5s after errors

# Cleanup configuration
CLEANUP_INTERVAL=3600000     # Run cleanup every hour
CLEANUP_AGE=86400000         # Remove jobs older than 1 day
```

### Docker Environment

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Environment defaults
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV WORKER_POLL_INTERVAL=1000
ENV WORKER_ERROR_BACKOFF=5000

COPY . .
RUN npm ci --production

CMD ["node", "dist/worker.js"]
```

## Scaling Strategies

### Horizontal Scaling (Multiple Workers)

```yaml
# docker-compose.production.yml
services:
  # Scale workers for different job types
  worker-generation:
    image: my-worker
    environment:
      WORKER_TYPE: generation
    volumes:
      - jobs-data:/app/data
    deploy:
      replicas: 3  # 3 generation workers

  worker-detection:
    image: my-worker
    environment:
      WORKER_TYPE: detection
    volumes:
      - jobs-data:/app/data
    deploy:
      replicas: 2  # 2 detection workers

volumes:
  jobs-data:
```

### Kubernetes Deployment

```yaml
# worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: job-worker
spec:
  replicas: 5
  selector:
    matchLabels:
      app: job-worker
  template:
    metadata:
      labels:
        app: job-worker
    spec:
      containers:
      - name: worker
        image: my-worker:latest
        env:
        - name: DATA_DIR
          value: /data
        volumeMounts:
        - name: jobs-data
          mountPath: /data
      volumes:
      - name: jobs-data
        persistentVolumeClaim:
          claimName: jobs-pvc
```

### Load Balancing

```typescript
// Distribute load by worker specialization
class SpecializedWorker extends JobWorker {
  private workerType: string;

  constructor(workerType: string) {
    super();
    this.workerType = workerType;
  }

  protected canProcessJob(job: Job): boolean {
    // Each worker only handles specific job types
    return job.type === this.workerType;
  }
}

// Deploy multiple workers for high-volume types
const generationWorker1 = new SpecializedWorker('generation');
const generationWorker2 = new SpecializedWorker('generation');
const generationWorker3 = new SpecializedWorker('generation');

const detectionWorker = new SpecializedWorker('detection');
```

## Monitoring

### Metrics Collection

```typescript
class MonitoredWorker extends JobWorker {
  private metrics = {
    processed: 0,
    failed: 0,
    totalDuration: 0,
  };

  protected async executeJob(job: Job): Promise<void> {
    const start = Date.now();

    try {
      await super.executeJob(job);
      this.metrics.processed++;
    } catch (error) {
      this.metrics.failed++;
      throw error;
    } finally {
      this.metrics.totalDuration += Date.now() - start;
    }
  }

  public getMetrics() {
    return {
      ...this.metrics,
      averageDuration: this.metrics.totalDuration / this.metrics.processed,
      errorRate: this.metrics.failed / (this.metrics.processed + this.metrics.failed),
    };
  }
}

// Expose metrics endpoint
app.get('/metrics', (req, res) => {
  res.json({
    worker: worker.getMetrics(),
  });
});
```

### Queue Monitoring

```typescript
async function getQueueStats() {
  const queue = getJobQueue();

  const [pending, running, complete, failed] = await Promise.all([
    queue.queryJobs({ status: 'pending' }),
    queue.queryJobs({ status: 'running' }),
    queue.queryJobs({ status: 'complete' }),
    queue.queryJobs({ status: 'failed' }),
  ]);

  return {
    pending: pending.length,
    running: running.length,
    complete: complete.length,
    failed: failed.length,
  };
}

// Periodic logging
setInterval(async () => {
  const stats = await getQueueStats();
  console.log('[Queue Stats]', stats);
}, 60000); // Every minute
```

## Troubleshooting

### Jobs Stuck in Running

**Symptom:** Jobs stay in `running/` directory forever

**Causes:**
- Worker crashed mid-processing
- Process killed without graceful shutdown

**Solution:**

```typescript
// On worker startup, move old running jobs back to pending
async function resetStuckJobs() {
  const queue = getJobQueue();
  const running = await queue.queryJobs({ status: 'running' });

  // Find jobs stuck for >5 minutes
  const fiveMinutesAgo = Date.now() - 300000;

  for (const job of running) {
    if (job.startedAt && new Date(job.startedAt).getTime() < fiveMinutesAgo) {
      console.log(`Resetting stuck job: ${job.id}`);
      job.status = 'pending';
      delete job.startedAt;
      await queue.updateJob(job, 'running');
    }
  }
}
```

### High Memory Usage

**Symptom:** Worker process memory grows over time

**Causes:**
- Large job payloads
- Not cleaning up completed jobs

**Solution:**

```typescript
// 1. Limit job query results
const pending = await queue.queryJobs({
  status: 'pending',
  limit: 100,  // Don't load thousands of jobs
});

// 2. Regular cleanup
setInterval(async () => {
  await queue.cleanupCompletedJobs(Date.now() - 86400000);
}, 3600000);
```

### Slow Job Processing

**Symptom:** Jobs take long time to process

**Diagnosis:**

```typescript
// Add timing logs
protected async executeJob(job: Job): Promise<void> {
  const start = Date.now();

  console.log(`[${this.getWorkerName()}] Starting job ${job.id}`);

  await actualWork(job);

  const duration = Date.now() - start;
  console.log(`[${this.getWorkerName()}] Completed job ${job.id} in ${duration}ms`);

  if (duration > 10000) {
    console.warn(`[${this.getWorkerName()}] Slow job detected: ${duration}ms`);
  }
}
```

### Permission Errors

**Symptom:** `EACCES` or `EPERM` errors

**Solution:**

```bash
# Check directory ownership
ls -la data/

# Fix permissions (Linux/macOS)
sudo chown -R appuser:appuser data/
chmod -R 755 data/

# Docker: use correct user
# Dockerfile
USER node
```
