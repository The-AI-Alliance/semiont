/**
 * The ports the harness hands to the processes it starts.
 *
 * A port taken from the system (`listen(0)`) and closed is free only until
 * something asks the system for a port again, and the process it is meant for
 * binds it some time later. Every double of every file asks the system for
 * its own. So a port the harness hands out is none the system would give, and
 * none another file running at the same time is handed.
 */
import { createServer, type AddressInfo, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { freePort, portsOfWorker, PORTS_PER_WORKER } from './net';

/** The lowest port Linux gives a server that asks for any (`ip_local_port_range`); macOS and the IANA range start higher. */
const LOWEST_THE_SYSTEM_GIVES = 32_768;

const listening = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
const closed = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

describe('a port for a process the harness starts', () => {
  it('is none the system gives a server that asks for any port', async () => {
    const any = await listening(0);
    const given = (any.address() as AddressInfo).port;
    await closed(any);
    expect(given).toBeGreaterThanOrEqual(LOWEST_THE_SYSTEM_GIVES);

    for (let i = 0; i < 20; i++) expect(await freePort()).toBeLessThan(LOWEST_THE_SYSTEM_GIVES);
  });

  it('is in the block of the vitest worker that asks, and no two workers share a block', async () => {
    // A test file runs in a worker that has an id. Without one every file
    // would take from the same ports, so its absence is refused, not defaulted.
    const worker = process.env['VITEST_POOL_ID'];
    expect(worker).toMatch(/^[1-9]\d*$/);
    const mine = portsOfWorker(worker);
    const port = await freePort();
    expect(port).toBeGreaterThanOrEqual(mine.first);
    expect(port).toBeLessThanOrEqual(mine.last);

    const blocks = ['1', '2', '3', '4', '5', '6', '7', '8'].map(portsOfWorker);
    for (const [index, block] of blocks.entries()) {
      expect(block.last - block.first + 1).toBe(PORTS_PER_WORKER);
      if (index > 0) expect(block.first).toBeGreaterThan(blocks[index - 1]!.last);
    }
    expect(() => portsOfWorker(undefined)).toThrow(/no vitest worker/);
    expect(() => portsOfWorker('0')).toThrow(/has no block/);
    expect(() => portsOfWorker('100000')).toThrow(/has no block/);
  });

  it('is never one something is listening on, however many are asked for', async () => {
    const held = await freePort();
    const holder = await listening(held);
    try {
      // More than a whole block, so the count comes round to the held one.
      for (let i = 0; i < PORTS_PER_WORKER + 10; i++) expect(await freePort()).not.toBe(held);
    } finally {
      await closed(holder);
    }
  });
});
