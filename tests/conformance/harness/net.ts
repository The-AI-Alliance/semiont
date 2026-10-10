import { createServer, connect } from 'node:net';

/**
 * The ports this harness hands to the processes it starts: 20000 to 29999, in
 * a block for each vitest worker.
 *
 * They are below every port a system gives a server that asks for any
 * (`listen(0)`): Linux starts at 32768, macOS and the IANA range higher. That
 * is the point of them. A port taken from the system and closed is free only
 * until something asks the system again, and the process it is meant for
 * binds it later, after it has read its configuration and signed in. Every
 * double of every file asks the system for a port of its own, so one of them
 * could be given that port in between. Then the process cannot listen, and
 * the harness's probes of its health reach another file's double.
 */
const FIRST_PORT = 20_000;
export const PORTS_PER_WORKER = 500;
const WORKERS = 20;

/**
 * The block of ports one vitest worker hands out from. `worker` is its
 * `VITEST_POOL_ID`, which no two workers running at the same time share, so
 * two files running at once are never handed the same port.
 *
 * A process with no id is refused: it would share a block with every other,
 * which is the collision these blocks are for.
 */
export function portsOfWorker(worker: string | undefined): { first: number; last: number } {
  if (worker === undefined) {
    throw new Error('no vitest worker is asking: a port is handed to a test file, whose worker has an id (VITEST_POOL_ID)');
  }
  const slot = Number(worker);
  if (!Number.isInteger(slot) || slot < 1 || slot > WORKERS) {
    throw new Error(`vitest worker ${worker} has no block of ports: there are blocks for workers 1 to ${WORKERS}`);
  }
  const first = FIRST_PORT + (slot - 1) * PORTS_PER_WORKER;
  return { first, last: first + PORTS_PER_WORKER - 1 };
}

/** Whether nothing is listening on a port of this machine. */
function nothingListensOn(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** How many ports this worker has handed out: the next is taken from where the last left off. */
let handedOut = 0;

/**
 * A port for a process the harness is about to start: the next of this
 * worker's block that nothing is listening on.
 */
export async function freePort(): Promise<number> {
  const { first } = portsOfWorker(process.env['VITEST_POOL_ID']);
  for (let tried = 0; tried < PORTS_PER_WORKER; tried++) {
    const port = first + (handedOut++ % PORTS_PER_WORKER);
    if (await nothingListensOn(port)) return port;
  }
  throw new Error(`something is listening on every one of the ${PORTS_PER_WORKER} ports from ${first}`);
}

export async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, host);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`nothing listened on ${host}:${port} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Poll until `probe` returns a value, or fail after `timeoutMs`. */
export async function eventually<T>(what: string, timeoutMs: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
