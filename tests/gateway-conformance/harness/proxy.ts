/**
 * A TCP proxy in front of a broker that can hold what a client sends: after
 * the NATS handshake (the client's CONNECT and its first PING, answered), the
 * client's bytes wait in the proxy until `release`. The broker's bytes always
 * pass. A client held there has connected, and nothing it registers or asks
 * of the broker has been seen by it.
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface HoldingProxy {
  readonly url: string;
  /** Hold every client's bytes after its handshake. */
  hold(): void;
  /** Let every held and later byte through. */
  release(): void;
  close(): Promise<void>;
}

const HANDSHAKE_END = Buffer.from('PING\r\n');

export async function startHoldingProxy(brokerPort: number): Promise<HoldingProxy> {
  let holding = false;
  const released: Array<() => void> = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    const broker = connect(brokerPort, '127.0.0.1');
    sockets.add(client).add(broker);
    broker.pipe(client);
    let seen = Buffer.alloc(0);
    let handshaken = false;
    const held: Buffer[] = [];
    const flush = () => {
      for (const chunk of held.splice(0)) broker.write(chunk);
    };
    client.on('data', (chunk: Buffer) => {
      if (!handshaken) {
        seen = Buffer.concat([seen, chunk]);
        const end = seen.indexOf(HANDSHAKE_END);
        if (end < 0) {
          broker.write(chunk);
          return;
        }
        handshaken = true;
        const through = end + HANDSHAKE_END.length - (seen.length - chunk.length);
        broker.write(chunk.subarray(0, through));
        chunk = chunk.subarray(through);
        if (chunk.length === 0) return;
      }
      if (holding) {
        held.push(chunk);
        released.push(flush);
      } else broker.write(chunk);
    });
    const end = () => {
      client.destroy();
      broker.destroy();
    };
    client.on('close', end).on('error', end);
    broker.on('close', end).on('error', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `nats://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      for (const flush of released.splice(0)) flush();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
