/**
 * JetStreamJobQueue tests — P1's RED is exactly one line: the conformance
 * suite (JOB-QUEUE-DRIVER P0) through a JetStream fixture.
 *
 * The fixture spawns a real `nats-server` from PATH per test (a single
 * static binary; JetStream state in a throwaway dir). No mocks: the
 * contract under test is claim atomicity, CAS merges and recovery, and a
 * mocked broker would prove none of it.
 *
 * Locally (Apple container): `apk add nats-server` in the test container.
 * CI: one install step in the workflow. Missing binary fails LOUDLY with
 * instructions — never a skip.
 *
 * This driver's staleness mechanism is the KV envelope's `lastProgressAt`
 * (the fs driver's is mtime): `ageRunningJob` rewrites it into the past
 * through a plain NATS connection — the fixture may touch the mechanism;
 * the conformance suite never does.
 */

import { describe, test, expect, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { connect } from 'nats';
import { JetStreamJobQueue } from '../jetstream-job-queue';
import { TERMINAL_JOB_RETENTION_MS } from '../job-queue-interface';
import type { JobId, Logger } from '@semiont/core';
import { createPendingDetectionJob, runJobQueueConformance } from './job-queue-conformance';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForServer(port: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`nats-server exited with ${proc.exitCode}`);
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', reject);
      });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('nats-server did not become ready within 10s');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

interface Auth {
  user: string;
  pass: string;
}

/**
 * JetStream state lives under `dataDir`, so a respawn on the same dir is a
 * broker RESTART — stream, consumer and bucket intact — not a fresh broker.
 */
async function spawnServer(port: number, dataDir: string, auth?: Auth): Promise<ChildProcess> {
  const args = ['-js', '-sd', dataDir, '-p', String(port), '-a', '127.0.0.1'];
  if (auth) args.push('--user', auth.user, '--pass', auth.pass);
  const server = spawn('nats-server', args, { stdio: 'ignore' });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new Error(
        'nats-server not found on PATH — the JetStream suite runs against a real server. ' +
        'Install it: `apk add nats-server` (alpine test container), `brew install nats-server` (mac), ' +
        'or the nats-io/nats-server release binary (CI).',
      );
    }
    throw error;
  });
  await waitForServer(port, server);
  return server;
}

describe('multi-instance — the property this plan exists to buy (JOB-QUEUE-DRIVER P2)', () => {
  test('two gateways over one NATS: every job completes exactly once, and every lease settles', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jetstream-multi-'));
    const port = await freePort();
    const server = await spawnServer(port, dataDir);
    const servers = `127.0.0.1:${port}`;

    // Short lease window so settle-reconciliation runs inside the test.
    const a = new JetStreamJobQueue({ servers, reconnect: false, ackWaitMs: 2_000 }, mockLogger);
    const b = new JetStreamJobQueue({ servers, reconnect: false, ackWaitMs: 2_000 }, mockLogger);
    const raw = await connect({ servers, reconnect: false });
    try {
      await a.initialize();
      await b.initialize();

      const ids = Array.from({ length: 12 }, (_, i) => `job-multi-${i}`);
      for (const id of ids) await a.createJob(createPendingDetectionJob(id));

      // Let deliveries spread across both instances' consumers.
      await new Promise((r) => setTimeout(r, 500));

      // BOTH gateways drain the queue concurrently by type-claim — the
      // mediated wire shape. Every claim takes the NEXT available job, so
      // nothing races for a single id; the CAS still guarantees one winner
      // per job when both fallbacks land on the same key.
      const { jobId } = await import('@semiont/core');
      const winners: string[] = [];
      await Promise.all([a, b].map(async (q) => {
        for (;;) {
          const r = await q.claimNextJob([]);
          if ('declined' in r) break;
          await q.completeJob(jobId(r.job.metadata.id as string), { by: q === a ? 'a' : 'b' });
          winners.push(r.job.metadata.id as string);
        }
      }));

      expect(winners.sort()).toEqual([...ids].sort()); // each job exactly once
      for (const id of ids) {
        expect((await a.getJob(jobId(id)))?.status).toBe('complete');
      }

      // EVERY lease settles: a delivery held by the instance that LOST the
      // claim (or that held a job the other instance completed) must be
      // acked once the job is terminal — otherwise the work-queue stream
      // never drains and the message redelivers forever.
      const jsm = await raw.jetstreamManager();
      const deadline = Date.now() + 10_000;
      for (;;) {
        const info = await jsm.streams.info('JOBS');
        if (info.state.messages === 0) break;
        if (Date.now() > deadline) {
          throw new Error(`stream never drained: ${info.state.messages} lease(s) unsettled`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      a.destroy();
      b.destroy();
      await raw.close();
      await new Promise((r) => setTimeout(r, 100));
      server.kill('SIGKILL');
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('the periodic tick — re-announce and worker-death sweep (driver-specific)', () => {
  test('an unclaimed pending job is re-announced, and a stale running job recovers without an explicit sweep call', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jetstream-tick-'));
    const port = await freePort();
    const server = await spawnServer(port, dataDir);
    const servers = `127.0.0.1:${port}`;

    const { EventBus, jobId } = await import('@semiont/core');
    const { createRunningDetectionJob } = await import('./job-queue-conformance');
    const bus = new EventBus();
    const announced: string[] = [];
    bus.on('job:queued').subscribe((e) => announced.push(e.jobId as string));

    const q = new JetStreamJobQueue({ servers, reconnect: false, tickMs: 300, staleRunningMs: 1 }, mockLogger, bus);
    try {
      await q.initialize();

      // (a) re-announce: the delivery announces once on arrival, then the
      // tick announces again while the job stays unclaimed.
      await q.createJob(createPendingDetectionJob('job-tick-1'));
      const deadline = Date.now() + 5_000;
      while (announced.filter((id) => id === 'job-tick-1').length < 2) {
        if (Date.now() > deadline) throw new Error(`re-announce never fired (announcements: ${announced.length})`);
        await new Promise((r) => setTimeout(r, 50));
      }

      // (b) wired sweep: a running job with staleRunningMs=1 recovers to
      // pending via the tick alone — no recoverStaleRunningJobs call here.
      await q.createJob(createRunningDetectionJob('job-tick-2'));
      const deadline2 = Date.now() + 5_000;
      for (;;) {
        const j = await q.getJob(jobId('job-tick-2'));
        if (j?.status === 'pending' && j.metadata.retryCount === 1) break;
        if (Date.now() > deadline2) throw new Error(`sweep never recovered the stale job (status: ${j?.status})`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      q.destroy();
      await new Promise((r) => setTimeout(r, 100));
      server.kill('SIGKILL');
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * The broker-outage contract of the queue's connection — the same three
 * facts the gateway's signal plane pins (`nats-reconnect.test.ts`), on the
 * Dispatcher's connection:
 *
 *  1. an outage longer than the library's default attempt budget (ten
 *     tries, ~20 s) is survived: a manual broker restart is the recovery,
 *     and the budget closing the connection for good is the bug the
 *     gateway found live on 2026-09-15;
 *  2. the outage is not silent: `[jobs BROKER-DOWN]` and
 *     `[jobs BROKER-RECONNECTED]`;
 *  3. credentials are re-presented on reconnect — and a broker back with a
 *     ROTATED pair is the outage retry-forever does not survive (two
 *     refusals end the client's loop), so the queue must say so:
 *     `[jobs BROKER-CLOSED]`, and writes fail rather than buffer.
 */
const USER = 'semiont';
const PASS = 'correct-horse-battery-staple';

function captureLogs() {
  const warns: string[] = [];
  const infos: string[] = [];
  const errors: Array<{ msg: string; meta?: unknown }> = [];
  const logger: Logger = {
    debug: () => {},
    info: (msg) => { infos.push(msg); },
    warn: (msg) => { warns.push(msg); },
    error: (msg, meta) => { errors.push({ msg, meta }); },
    child: () => logger,
  };
  return { logger, warns, infos, errors };
}

async function settle(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const has = (lines: string[], breadcrumb: string) => lines.some((m) => m.includes(breadcrumb));

/** Created, delivered to this instance's consumer, claimed, completed: the whole path, not just the bucket. */
async function proveQueue(q: JetStreamJobQueue, id: string): Promise<void> {
  const { jobId } = await import('@semiont/core');
  await q.createJob(createPendingDetectionJob(id));
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await q.claimNextJob([]);
    if ('job' in r) {
      expect(r.job.metadata.id, 'the claim took a job this test did not create').toBe(id);
      await q.completeJob(jobId(id), {});
      return;
    }
    if (Date.now() > deadline) throw new Error(`${id} was created but never delivered for claim`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

describe('broker outage and return — the queue connection', () => {
  test('an outage longer than the default attempt budget is survived, and both breadcrumbs fire', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jetstream-outage-'));
    const port = await freePort();
    let server = await spawnServer(port, dataDir);
    const log = captureLogs();
    const q = new JetStreamJobQueue({ servers: `127.0.0.1:${port}` }, log.logger);
    try {
      await q.initialize();
      await proveQueue(q, 'job-outage-before');

      server.kill('SIGKILL');
      await settle(() => has(log.warns, '[jobs BROKER-DOWN]'), 10_000);
      expect(has(log.warns, '[jobs BROKER-DOWN]'), 'outage breadcrumb').toBe(true);

      // Past ten attempts two seconds apart.
      await new Promise((r) => setTimeout(r, 25_000));
      server = await spawnServer(port, dataDir);
      await settle(() => has(log.infos, '[jobs BROKER-RECONNECTED]'), 10_000);
      expect(has(log.infos, '[jobs BROKER-RECONNECTED]'), 'return breadcrumb').toBe(true);

      await proveQueue(q, 'job-outage-after');
    } finally {
      q.destroy();
      await new Promise((r) => setTimeout(r, 100));
      server.kill('SIGKILL');
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('an authenticated broker restarted with the same credentials admits the same queue', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jetstream-auth-'));
    const port = await freePort();
    const auth = { user: USER, pass: PASS };
    let server = await spawnServer(port, dataDir, auth);
    const log = captureLogs();
    const q = new JetStreamJobQueue({ servers: `127.0.0.1:${port}`, ...auth }, log.logger);
    try {
      await q.initialize();
      await proveQueue(q, 'job-auth-before');

      server.kill('SIGKILL');
      await settle(() => has(log.warns, '[jobs BROKER-DOWN]'), 10_000);

      server = await spawnServer(port, dataDir, auth);
      await settle(() => has(log.infos, '[jobs BROKER-RECONNECTED]'), 10_000);
      expect(has(log.infos, '[jobs BROKER-RECONNECTED]'), 'credentials re-presented on reconnect').toBe(true);

      await proveQueue(q, 'job-auth-after');
    } finally {
      q.destroy();
      await new Promise((r) => setTimeout(r, 100));
      server.kill('SIGKILL');
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('restarted with different credentials, the queue stops retrying and says so', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jetstream-rotated-'));
    const port = await freePort();
    let server = await spawnServer(port, dataDir, { user: USER, pass: PASS });
    const log = captureLogs();
    const q = new JetStreamJobQueue({ servers: `127.0.0.1:${port}`, user: USER, pass: PASS }, log.logger);
    try {
      await q.initialize();
      await proveQueue(q, 'job-rotated-before');

      server.kill('SIGKILL');
      await settle(() => has(log.warns, '[jobs BROKER-DOWN]'), 10_000);

      server = await spawnServer(port, dataDir, { user: USER, pass: 'rotated' });
      // Two refusals end the loop: two attempts, ~2 s apart.
      await settle(() => log.errors.some((e) => e.msg.includes('[jobs BROKER-CLOSED]')), 20_000);

      const closed = log.errors.find((e) => e.msg.includes('[jobs BROKER-CLOSED]'));
      expect(closed, 'the queue went dark without a breadcrumb').toBeDefined();
      expect(closed!.meta).toMatchObject({ reason: 'AUTHORIZATION_VIOLATION' });
      expect(has(log.infos, '[jobs BROKER-RECONNECTED]'), 'no false recovery').toBe(false);
      await expect(
        q.createJob(createPendingDetectionJob('job-after-rotation')),
        'a closed queue refuses writes; it must not buffer them forever',
      ).rejects.toThrow();
    } finally {
      q.destroy();
      await new Promise((r) => setTimeout(r, 100));
      server.kill('SIGKILL');
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('terminal-job retention — the janitor the fs driver never lost (driver-specific)', () => {
  test('a concluded job past the window leaves the bucket, record and all; everything else stays', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jetstream-retention-'));
    const port = await freePort();
    const server = await spawnServer(port, dataDir);
    const servers = `127.0.0.1:${port}`;

    const { jobId } = await import('@semiont/core');
    const { createCompleteDetectionJob, createFailedDetectionJob, createRunningDetectionJob } =
      await import('./job-queue-conformance');
    const raw = await connect({ servers, reconnect: false });
    const q = new JetStreamJobQueue({ servers, reconnect: false }, mockLogger);
    try {
      await q.initialize();

      const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

      const staleComplete = createCompleteDetectionJob('job-ret-complete');
      staleComplete.completedAt = daysAgo(2);
      const staleFailed = createFailedDetectionJob('job-ret-failed');
      staleFailed.completedAt = daysAgo(2);
      const freshComplete = createCompleteDetectionJob('job-ret-fresh');

      await q.createJob(staleComplete);
      await q.createJob(staleFailed);
      await q.createJob(freshComplete);
      // A job still in flight is older than the window and must not be touched
      // by it: retention reads STATUS, which is the whole reason this is a
      // sweep and not a bucket TTL.
      await q.createJob(createRunningDetectionJob('job-ret-running'));
      await q.createJob(createPendingDetectionJob('job-ret-pending'));

      const pruned = await q.pruneTerminalJobs(TERMINAL_JOB_RETENTION_MS);

      expect(pruned).toBe(2);
      expect(await q.getJob(jobId('job-ret-complete'))).toBeNull();
      expect(await q.getJob(jobId('job-ret-failed'))).toBeNull();
      expect(await q.getJob(jobId('job-ret-fresh'))).not.toBeNull();
      expect(await q.getJob(jobId('job-ret-running'))).not.toBeNull();
      expect(await q.getJob(jobId('job-ret-pending'))).not.toBeNull();

      // getStats stops counting what retention dropped — the gauge behind
      // `semiont status` is a window, not a running total.
      expect(await q.getStats()).toMatchObject({ complete: 1, failed: 0, running: 1, pending: 1 });

      // …and the bucket keeps NOTHING for a pruned job. This is the gate on
      // the KV wire names the sweep purges through: a delete or purge through
      // the KV API would leave a tombstone message per job forever, so three
      // surviving keys must mean exactly three messages.
      const jsm = await raw.jetstreamManager();
      const info = await jsm.streams.info('KV_jobs');
      expect(info.state.messages, 'a pruned job left a marker behind').toBe(3);
    } finally {
      q.destroy();
      await raw.close();
      await new Promise((r) => setTimeout(r, 100));
      server.kill('SIGKILL');
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

runJobQueueConformance('JetStreamJobQueue', {
  async setup() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jetstream-test-'));
    const port = await freePort();
    const server = await spawnServer(port, dataDir);

    const servers = `127.0.0.1:${port}`;
    const opened: JetStreamJobQueue[] = [];

    return {
      async open() {
        const queue = new JetStreamJobQueue({ servers, reconnect: false }, mockLogger);
        await queue.initialize();
        opened.push(queue);
        return queue;
      },
      // This driver's staleness signal is the KV envelope's lastProgressAt.
      async ageRunningJob(id: JobId) {
        const nc = await connect({ servers, reconnect: false });
        try {
          const kv = await nc.jetstream().views.kv('jobs');
          const entry = await kv.get(id as string);
          if (!entry) throw new Error(`ageRunningJob: no KV entry for ${id}`);
          const envelope = JSON.parse(new TextDecoder().decode(entry.value)) as { job: unknown; lastProgressAt: string };
          envelope.lastProgressAt = new Date(Date.now() - 31 * 60_000).toISOString();
          await kv.update(id as string, new TextEncoder().encode(JSON.stringify(envelope)), entry.revision);
        } finally {
          await nc.close();
        }
      },
      recoverStale(queue) {
        return (queue as JetStreamJobQueue).recoverStaleRunningJobs();
      },
      async teardown() {
        for (const queue of opened) queue.destroy();
        // Give fire-and-forget connection closes a beat before the server dies.
        await new Promise((r) => setTimeout(r, 100));
        server.kill('SIGKILL');
        await fs.rm(dataDir, { recursive: true, force: true });
      },
    };
  },
});
