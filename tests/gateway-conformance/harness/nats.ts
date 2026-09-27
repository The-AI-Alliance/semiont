/**
 * A real NATS broker for the NATS-plane cases: a mocked broker would prove
 * nothing about subjects, queue groups or the key-value tables. Spawned from
 * PATH on a free port, with JetStream unless a case asks for a broker without
 * it, and with a user and password when a case asks for them. It can be
 * restarted on the same port and store — with other credentials, if a case
 * wants the gateway to find the broker changed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, waitForTcp } from './net';

export interface BrokerOptions {
  jetstream?: boolean;
  user?: string;
  password?: string;
}

export interface Broker {
  readonly url: string;
  readonly port: number;
  /** Stop it and start it again on the same port and store. */
  restart(options?: { user?: string; password?: string }): Promise<void>;
  /** Stop it, leaving its port closed until `start`. */
  down(): Promise<void>;
  start(options?: { user?: string; password?: string }): Promise<void>;
  stop(): Promise<void>;
}

export async function startBroker(options: BrokerOptions = {}): Promise<Broker> {
  const jetstream = options.jetstream ?? true;
  const port = await freePort();
  const store = mkdtempSync(join(tmpdir(), 'gateway-conformance-nats-'));
  let child: ChildProcess | undefined;

  const launch = async (auth: { user?: string; password?: string }) => {
    child = spawn(
      'nats-server',
      [
        '-a', '127.0.0.1', '-p', String(port),
        ...(jetstream ? ['-js', '-sd', store] : []),
        ...(auth.user ? ['--user', auth.user, '--pass', auth.password ?? ''] : []),
      ],
      { stdio: 'ignore' },
    );
    await waitForTcp('127.0.0.1', port, 10_000);
  };
  const halt = async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child!.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  };

  await launch(options);
  return {
    url: `nats://127.0.0.1:${port}`,
    port,
    async restart(auth = options) {
      await halt();
      await launch(auth);
    },
    down: halt,
    start: (auth = options) => launch(auth),
    async stop() {
      await halt();
      rmSync(store, { recursive: true, force: true });
    },
  };
}
