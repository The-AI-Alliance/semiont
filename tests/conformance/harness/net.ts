import { createServer, connect, type AddressInfo } from 'node:net';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
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
