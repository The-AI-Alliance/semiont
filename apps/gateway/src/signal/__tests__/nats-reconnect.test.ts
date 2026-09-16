/**
 * The broker-outage contract of the NATS driver, pinned after the Live gate
 * found both halves broken/silent (2026-09-15):
 *
 *  1. the connection outlives an outage and delivery RESUMES after the
 *     broker returns — manual broker restart is the recovery mechanism, so
 *     `maxReconnectAttempts: -1` (the library default of 10 attempts closed
 *     the connection permanently at ~20 s; this test's outage is shorter,
 *     so what it pins is the resume path, not the attempt budget — the
 *     budget's story lives in the driver comment);
 *  2. the outage is NOT silent (LIVENESS-AXIOMS L4): a `[signal
 *     BROKER-DOWN]` breadcrumb on disconnect and `[signal
 *     BROKER-RECONNECTED]` on return — the two lines an operator greps.
 *
 * Runs its OWN server on a fixed port (the shared fixture must not be
 * killed under the other suites), with the plane's production reconnect
 * behavior — the one place `reconnect: false` is deliberately NOT passed.
 */
import { afterEach, beforeAll, describe, test, expect, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { getLogger, initializeLogger } from '../../logger';
import { toReplyAddress } from '../interface';
import { createNatsSignalPlane } from '../nats';
import { freePort, waitForServer } from './nats-fixture';

async function settle(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const spawnServer = async (port: number): Promise<ChildProcess> => {
  const proc = spawn('nats-server', ['-p', String(port), '-a', '127.0.0.1'], { stdio: 'ignore' });
  await waitForServer(port, proc);
  return proc;
};

beforeAll(() => {
  initializeLogger('error');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NATS driver — broker outage and return', () => {
  test('delivery resumes after a broker restart, and both breadcrumbs fire', async () => {
    const warns: string[] = [];
    const infos: string[] = [];
    vi.spyOn(getLogger(), 'child').mockReturnValue({
      warn: (msg: string) => warns.push(msg),
      info: (msg: string) => infos.push(msg),
      error: vi.fn(),
      debug: vi.fn(),
    } as never);

    const port = await freePort();
    let server = await spawnServer(port);
    const plane = await createNatsSignalPlane({ servers: `127.0.0.1:${port}` });
    try {
      const frames: unknown[] = [];
      plane.subscribeClient({
        address: toReplyAddress('outage-probe'),
        global: ['beckon:focus'],
        scoped: [],
        onFrame: (_c, payload) => frames.push(payload),
      });
      // Emit-until-seen: the publish can beat the subscription's server-side
      // registration; duplicates are contract-tolerated.
      await settle(() => {
        if (frames.length >= 1) return true;
        plane.ingest('beckon:focus', { n: 'baseline' });
        return false;
      });
      expect(frames.length, 'baseline delivery').toBeGreaterThanOrEqual(1);

      server.kill();
      await settle(() => warns.some((m) => m.includes('[signal BROKER-DOWN]')));
      expect(warns.some((m) => m.includes('[signal BROKER-DOWN]')), 'outage breadcrumb').toBe(true);

      server = await spawnServer(port);
      await settle(() => infos.some((m) => m.includes('[signal BROKER-RECONNECTED]')));
      expect(
        infos.some((m) => m.includes('[signal BROKER-RECONNECTED]')),
        'return breadcrumb',
      ).toBe(true);

      // The whole point of retry-forever: the SAME plane delivers again,
      // subscriptions re-established, no re-construction.
      const before = frames.length;
      await settle(() => {
        if (frames.length > before) return true;
        plane.ingest('beckon:focus', { n: 'after-restart' });
        return false;
      });
      expect(frames.length, 'delivery resumed after broker restart').toBeGreaterThan(before);
    } finally {
      plane.dispose();
      server.kill();
    }
  }, 30_000);
});
