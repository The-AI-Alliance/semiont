/**
 * An HTTP proxy between a client and a gateway, for the suites whose subject
 * is the CLIENT. It does two things a test cannot do from inside a client it
 * does not own:
 *
 * - it records every request the client makes, in order, with its JSON body —
 *   the authoritative account of what the client put on the wire (the
 *   subscribe matrix, the watermarks, the replies it still awaits, each emit);
 * - it ends the client's connections from outside (`cut`), and refuses new
 *   ones (`down`) until told otherwise (`up`): a dropped stream and an outage,
 *   as the client meets them.
 *
 * Everything else passes through untouched, streams included. The gateway
 * behind it is the real one, so nothing here models what a gateway does.
 */
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface ProxiedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The body parsed as JSON, when it is JSON. */
  json: unknown;
  /** The status the gateway answered with; unset until it has, and for good if the exchange was cut first. */
  status: number | undefined;
}

export interface ClientProxy {
  /** Where a client is pointed instead of the gateway. */
  readonly origin: string;
  /** Every request so far, in the order they arrived. */
  readonly requests: ProxiedRequest[];
  /** The first request, at or after index `from`, that `match` accepts. */
  next(what: string, match: (r: ProxiedRequest) => boolean, timeoutMs?: number, from?: number): Promise<ProxiedRequest>;
  /** End every connection the proxy holds — open streams and requests in flight. New ones are still accepted. */
  cut(): void;
  /** Cut, and refuse every new connection until `up()`. */
  down(): void;
  up(): void;
  close(): Promise<void>;
}

export async function startClientProxy(gatewayOrigin: string): Promise<ClientProxy> {
  const gateway = new URL(gatewayOrigin);
  const requests: ProxiedRequest[] = [];
  const sockets = new Set<Socket>();
  let waiters: Array<() => void> = [];
  let refusing = false;

  const wake = () => {
    const waiting = waiters;
    waiters = [];
    for (const w of waiting) w();
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let json: unknown;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        json = undefined;
      }
      const recorded: ProxiedRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, json, status: undefined };
      requests.push(recorded);
      wake();

      const upstream = request(
        {
          host: gateway.hostname,
          port: gateway.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: gateway.host },
        },
        (answer) => {
          recorded.status = answer.statusCode;
          wake();
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          // A stream's headers must reach the client before its first frame does.
          res.flushHeaders();
          answer.pipe(res);
          answer.on('error', () => res.destroy());
        },
      );
      upstream.on('error', () => res.destroy());
      // The client going away ends the gateway's half too, as it would unproxied.
      res.on('close', () => upstream.destroy());
      upstream.end(body);
    });
    req.on('error', () => res.destroy());
  });

  server.on('connection', (socket) => {
    if (refusing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cut = () => {
    for (const socket of sockets) socket.destroy();
  };

  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    async next(what, match, timeoutMs = 10_000, from = 0) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = requests.slice(from).find(match);
        if (found) return found;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    cut,
    down() {
      refusing = true;
      cut();
    },
    up() {
      refusing = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        cut();
        server.close(() => resolve());
      }),
  };
}
