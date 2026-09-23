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
 * And the authenticated half (INTER-COMPONENT-ACCESS P3):
 *
 *  3. the client re-presents its credentials on every reconnect, so a
 *     broker that requires them admits the same plane after a restart;
 *  4. a broker that comes back with DIFFERENT credentials is the one outage
 *     retry-forever does not survive: two refusals in a row end the
 *     client's reconnect loop, whatever the attempt budget says, and the
 *     plane must say so — `[signal BROKER-CLOSED]` — rather than go dark.
 *
 * Runs its OWN server on a fixed port (the shared fixture must not be
 * killed under the other suites), with the plane's production reconnect
 * behavior — the one place `reconnect: false` is deliberately NOT passed.
 */
import { afterEach, beforeAll, describe, test, expect, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { getLogger, initializeLogger } from '../../logger';
import { toReplyAddress, type SignalPlane } from '../interface';
import { createNatsSignalPlane } from '../nats';
import { freePort, waitForServer } from './nats-fixture';

const USER = 'semiont';
const PASS = 'correct-horse-battery-staple';

interface Auth {
  user: string;
  pass: string;
}

async function settle(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const spawnServer = async (port: number, auth?: Auth): Promise<ChildProcess> => {
  const args = ['-p', String(port), '-a', '127.0.0.1'];
  if (auth) args.push('--user', auth.user, '--pass', auth.pass);
  const proc = spawn('nats-server', args, { stdio: 'ignore' });
  await waitForServer(port, proc);
  return proc;
};

function captureLogs() {
  const warns: string[] = [];
  const infos: string[] = [];
  const errors: Array<{ msg: string; meta?: unknown }> = [];
  vi.spyOn(getLogger(), 'child').mockReturnValue({
    warn: (msg: string) => warns.push(msg),
    info: (msg: string) => infos.push(msg),
    error: (msg: string, meta?: unknown) => errors.push({ msg, meta }),
    debug: vi.fn(),
  } as never);
  return { warns, infos, errors };
}

function probe(plane: SignalPlane): unknown[] {
  const frames: unknown[] = [];
  plane.subscribeClient({
    address: toReplyAddress('outage-probe'),
    global: ['beckon:focus'],
    scoped: [],
    onFrame: (_c, payload) => frames.push(payload),
  });
  return frames;
}

// Emit-until-seen: the publish can beat the subscription's server-side
// registration; duplicates are contract-tolerated.
async function proveDelivery(plane: SignalPlane, frames: unknown[]): Promise<void> {
  const before = frames.length;
  await settle(() => {
    if (frames.length > before) return true;
    plane.ingest('beckon:focus', { n: before });
    return false;
  });
  expect(frames.length, 'delivery').toBeGreaterThan(before);
}

const has = (lines: string[], breadcrumb: string) => lines.some((m) => m.includes(breadcrumb));

beforeAll(() => {
  initializeLogger('error');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NATS driver — broker outage and return', () => {
  test('delivery resumes after a broker restart, and both breadcrumbs fire', async () => {
    const log = captureLogs();
    const port = await freePort();
    let server = await spawnServer(port);
    const plane = await createNatsSignalPlane({ servers: `127.0.0.1:${port}` });
    try {
      const frames = probe(plane);
      await proveDelivery(plane, frames);

      server.kill();
      await settle(() => has(log.warns, '[signal BROKER-DOWN]'));
      expect(has(log.warns, '[signal BROKER-DOWN]'), 'outage breadcrumb').toBe(true);

      server = await spawnServer(port);
      await settle(() => has(log.infos, '[signal BROKER-RECONNECTED]'));
      expect(has(log.infos, '[signal BROKER-RECONNECTED]'), 'return breadcrumb').toBe(true);

      // The whole point of retry-forever: the SAME plane delivers again,
      // subscriptions re-established, no re-construction.
      await proveDelivery(plane, frames);
    } finally {
      plane.dispose();
      server.kill();
    }
  }, 30_000);

  test('an authenticated broker restarted with the same credentials admits the same plane', async () => {
    const log = captureLogs();
    const port = await freePort();
    const auth = { user: USER, pass: PASS };
    let server = await spawnServer(port, auth);
    const plane = await createNatsSignalPlane({ servers: `127.0.0.1:${port}`, ...auth });
    try {
      const frames = probe(plane);
      await proveDelivery(plane, frames);

      server.kill();
      await settle(() => has(log.warns, '[signal BROKER-DOWN]'));

      server = await spawnServer(port, auth);
      await settle(() => has(log.infos, '[signal BROKER-RECONNECTED]'));
      expect(
        has(log.infos, '[signal BROKER-RECONNECTED]'),
        'credentials re-presented on reconnect',
      ).toBe(true);

      await proveDelivery(plane, frames);
    } finally {
      plane.dispose();
      server.kill();
    }
  }, 30_000);

  test('restarted with different credentials, the plane stops retrying and says so', async () => {
    const log = captureLogs();
    const port = await freePort();
    let server = await spawnServer(port, { user: USER, pass: PASS });
    const plane = await createNatsSignalPlane({ servers: `127.0.0.1:${port}`, user: USER, pass: PASS });
    try {
      const frames = probe(plane);
      await proveDelivery(plane, frames);

      server.kill();
      await settle(() => has(log.warns, '[signal BROKER-DOWN]'));

      server = await spawnServer(port, { user: USER, pass: 'rotated' });
      // Two refusals end the loop: two attempts, ~2 s apart.
      await settle(() => log.errors.some((e) => e.msg.includes('[signal BROKER-CLOSED]')), 20_000);

      const closed = log.errors.find((e) => e.msg.includes('[signal BROKER-CLOSED]'));
      expect(closed, 'the plane went dark without a breadcrumb').toBeDefined();
      expect(closed!.meta).toMatchObject({ reason: 'AUTHORIZATION_VIOLATION' });
      expect(has(log.infos, '[signal BROKER-RECONNECTED]'), 'no false recovery').toBe(false);
      expect(
        () => plane.ingest('beckon:focus', { n: 'after-rotation' }),
        'a closed plane refuses emits; it must not buffer them forever',
      ).toThrow();
    } finally {
      plane.dispose();
      server.kill();
    }
  }, 40_000);
});
