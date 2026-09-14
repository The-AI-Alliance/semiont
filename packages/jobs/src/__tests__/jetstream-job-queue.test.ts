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
import type { JobId } from '@semiont/core';
import { runJobQueueConformance } from './job-queue-conformance';

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

describe('multi-instance — the property this plan exists to buy (JOB-QUEUE-DRIVER P2)', () => {
  test('two gateways over one NATS: every job completes exactly once, and every lease settles', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jetstream-multi-'));
    const port = await freePort();
    const server = spawn('nats-server', ['-js', '-sd', dataDir, '-p', String(port), '-a', '127.0.0.1'], { stdio: 'ignore' });
    await waitForServer(port, server);
    const servers = `127.0.0.1:${port}`;

    // Short lease window so settle-reconciliation runs inside the test.
    const a = new JetStreamJobQueue({ servers, reconnect: false, ackWaitMs: 2_000 }, mockLogger);
    const b = new JetStreamJobQueue({ servers, reconnect: false, ackWaitMs: 2_000 }, mockLogger);
    const raw = await connect({ servers, reconnect: false });
    try {
      await a.initialize();
      await b.initialize();

      const ids = Array.from({ length: 12 }, (_, i) => `job-multi-${i}`);
      const { createPendingDetectionJob } = await import('./job-queue-conformance');
      for (const id of ids) await a.createJob(createPendingDetectionJob(id));

      // Let deliveries spread across both instances' consumers.
      await new Promise((r) => setTimeout(r, 500));

      // Worst case, deliberately: BOTH gateways race to claim EVERY job —
      // at-least-once delivery, effects-once via the claim CAS. Exactly one
      // winner per job completes it.
      const { jobId } = await import('@semiont/core');
      const winners: string[] = [];
      await Promise.all(ids.flatMap((id) => [a, b].map(async (q) => {
        const r = await q.claimJob(jobId(id));
        if ('job' in r) {
          await q.completeJob(jobId(id), { by: q === a ? 'a' : 'b' });
          winners.push(id);
        }
      })));

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

runJobQueueConformance('JetStreamJobQueue', {
  async setup() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jetstream-test-'));
    const port = await freePort();
    const server = spawn('nats-server', ['-js', '-sd', dataDir, '-p', String(port), '-a', '127.0.0.1'], {
      stdio: 'ignore',
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new Error(
          'nats-server not found on PATH — the JetStream conformance suite runs against a real server. ' +
          'Install it: `apk add nats-server` (alpine test container), `brew install nats-server` (mac), ' +
          'or the nats-io/nats-server release binary (CI).',
        );
      }
      throw error;
    });
    await waitForServer(port, server);

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
