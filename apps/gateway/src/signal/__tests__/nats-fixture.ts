/**
 * A real `nats-server` for the signal conformance suite — spawned from PATH,
 * the jobs-suite pattern (`jetstream-job-queue.test.ts`), with one deliberate
 * difference: **no `-js`, no `-sd`**. The signal plane is core subjects only
 * (D3), and a server with JetStream disabled makes capture structurally
 * impossible in the very environment that certifies the driver.
 *
 * CI installs the binary (ci.yml, test-gateway); locally (Apple container):
 * `apk add nats-server` in the test container. This file deliberately does
 * NOT import the `nats` client — readiness is a TCP probe — so the
 * driver-boundary census can pin the client import to exactly one file.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';

export interface NatsFixture {
  servers: string;
  stop(): void;
}

export async function freePort(): Promise<number> {
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

export async function waitForServer(port: number, proc: ChildProcess): Promise<void> {
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

/**
 * A server that REQUIRES a user and password, for the authentication gate.
 * Not shared: the point of it is that a client without credentials is refused,
 * so it must not be reachable by the suites that connect anonymously.
 *
 * Credentials go on argv here because this is a throwaway on a free port. The
 * launcher stages a config file instead — argv is visible in every process
 * listing, and that is the one place a real broker password must not appear.
 */
export async function authenticatedNatsFixture(
  user: string,
  pass: string,
): Promise<NatsFixture> {
  const port = await freePort();
  const server = spawn('nats-server', ['-p', String(port), '-a', '127.0.0.1', '--user', user, '--pass', pass], {
    stdio: 'ignore',
  });
  await waitForServer(port, server);
  return {
    servers: `127.0.0.1:${port}`,
    stop() {
      server.kill();
    },
  };
}

let shared: Promise<NatsFixture> | undefined;

/** One core-only server per test file, shared across the suite's makes. */
export function natsFixture(): Promise<NatsFixture> {
  if (!shared) {
    shared = (async () => {
      const port = await freePort();
      const server = spawn('nats-server', ['-p', String(port), '-a', '127.0.0.1'], {
        stdio: 'ignore',
      });
      await waitForServer(port, server);
      return {
        servers: `127.0.0.1:${port}`,
        stop() {
          server.kill();
          shared = undefined;
        },
      };
    })();
  }
  return shared;
}
