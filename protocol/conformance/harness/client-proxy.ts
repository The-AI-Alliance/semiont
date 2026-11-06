/**
 * An HTTP proxy between a client and a gateway, for the suites whose subject
 * is the CLIENT. It does what a test cannot do from inside a client it does
 * not own:
 *
 * - it records every request the client makes, in order, with its JSON body —
 *   the authoritative account of what the client put on the wire (the
 *   subscribe matrix, the watermarks, the replies it still awaits, each emit);
 * - it records every event each stream carried to the client, as the gateway
 *   wrote it, so what a client says it received can be held to what it was
 *   sent;
 * - it ends the client's connections from outside (`cut`), and refuses new
 *   ones (`down`) until told otherwise (`up`): a dropped stream and an outage,
 *   as the client meets them;
 * - it keeps a request waiting (`hold`, `release`), answers one itself with a
 *   refusal a case scripted (`answer`), reads one whole and closes its
 *   connection with no answer (`leaveUnanswered`), passes one on and closes its
 *   connection with none of the gateway's answer written (`loseAnswer`), and
 *   passes a stream on a few bytes at a time (`rechunk`);
 * - it writes onto the client's stream a frame the gateway never sends
 *   (`carry`): a frame BusFrame refuses, or one whose payload is not its
 *   channel's, as a client meets one from a gateway newer or older than it.
 *
 * Everything else passes through untouched, streams included. The gateway
 * behind it is the real one. `answer` and `carry` are the two places the
 * proxy speaks for it: the caller holds what `answer` says to the spec before
 * using it, and what `carry` writes is recorded among the events its stream
 * carried.
 */
import { createServer, request, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** One Server-Sent Event a stream carried, as the gateway wrote it, or as `carry` wrote it in the gateway's place. */
export interface CarriedEvent {
  event: string;
  id: string | undefined;
  data: string;
  /** When the proxy read it, on the clock `arrived` and `answered` share. */
  at: number;
}

export interface ProxiedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The body parsed as JSON, when it is JSON. */
  json: unknown;
  /** The status it was answered with; unset until it has been, and for good if the exchange was cut first. */
  status: number | undefined;
  /**
   * When it arrived and when it was answered, on one clock every request and
   * event shares: `a.answered < b.arrived` reads "a was answered before b arrived".
   */
  arrived: number;
  answered: number | undefined;
  /** The same two moments in milliseconds, and the seconds its answer's `Retry-After` stated: for holding a client to a wait it was told. */
  arrivedMs: number;
  answeredMs: number | undefined;
  retryAfter: number | undefined;
  /** The answer's body parsed as JSON, when it is JSON and not a stream. */
  answer: unknown;
  /** The events its answer carried, when the answer is a stream. */
  events: CarriedEvent[];
  /** Whether the exchange is over: answered in full, or its connection ended, by either side. */
  closed: boolean;
  /** Whether the gateway's answer, which `status` and `answer` record, was kept from the client (`loseAnswer`). */
  answerLost: boolean;
}

/** An answer the proxy gives itself, in the gateway's place. */
export interface ScriptedAnswer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: string;
}

export interface ClientProxy {
  /** Where a client is pointed instead of the gateway. */
  readonly origin: string;
  /** Every request so far, in the order they arrived. */
  readonly requests: ProxiedRequest[];
  /** The clock's reading: everything recorded from here on is later than it. */
  now(): number;
  /** Resolves with what `probe` returns once that is not undefined; asked again whenever anything the proxy records changes. */
  until<T>(what: string, probe: () => T | undefined, timeoutMs?: number): Promise<T>;
  /** The first request, at or after index `from`, that `match` accepts. */
  next(what: string, match: (r: ProxiedRequest) => boolean, timeoutMs?: number, from?: number): Promise<ProxiedRequest>;
  /** End every connection the proxy holds — open streams and requests in flight. New ones are still accepted. */
  cut(): void;
  /** Cut, and refuse every new connection until `up()`. */
  down(): void;
  up(): void;
  /** Keep every request `match` accepts waiting, recorded and not passed on, until `release()`. */
  hold(match: (r: ProxiedRequest) => boolean): void;
  release(): void;
  /** Answer the next `times` requests `match` accepts with `answer`, without passing them on. */
  answer(match: (r: ProxiedRequest) => boolean, answer: ScriptedAnswer, times: number): void;
  /**
   * Read the next `times` requests `match` accepts whole, pass none on, and
   * close each one's connection with nothing written: a request the gateway
   * dropped unanswered, as the client meets it.
   */
  leaveUnanswered(match: (r: ProxiedRequest) => boolean, times: number): void;
  /**
   * Pass the next `times` requests `match` accepts on, record the gateway's
   * whole answer to each, and close each one's connection with none of it
   * written: a request the gateway carried out whose answer the client never
   * got. Not for a stream, whose answer has no end to wait for.
   */
  loseAnswer(match: (r: ProxiedRequest) => boolean, times: number): void;
  /** Pass every stream on `bytes` at a time, each piece written on its own. */
  rechunk(bytes: number): void;
  /**
   * Write a `bus-event` whose `data` is `data` onto the stream opened last of
   * those still open, between two of the events the gateway writes, and record
   * it among the events that stream carried. It carries no `id`.
   */
  carry(data: string): void;
  close(): Promise<void>;
}

/** What reads Server-Sent Events out of a byte stream, whatever the chunks it arrives in. */
interface EventReader {
  read(chunk: Buffer): void;
  /** Whether everything read so far ends between two events, so an event written now is one of its own. */
  between(): boolean;
}

function eventReader(onEvent: (event: string, id: string | undefined, data: string) => void): EventReader {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let id: string | undefined;
  let data: string[] = [];
  let sawData = false;
  const between = (): boolean => buffer === '' && event === '' && id === undefined && !sawData;
  const read = (chunk: Buffer): void => {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line === '') {
        if (event || sawData) onEvent(event || 'message', id, data.join('\n'));
        event = '';
        id = undefined;
        data = [];
        sawData = false;
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') {
        data.push(value);
        sawData = true;
      }
    }
  };
  return { read, between };
}

const mediaType = (headers: IncomingHttpHeaders): string => (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();

export async function startClientProxy(gatewayOrigin: string): Promise<ClientProxy> {
  const gateway = new URL(gatewayOrigin);
  const requests: ProxiedRequest[] = [];
  const sockets = new Set<Socket>();
  let waiters: Array<() => void> = [];
  let refusing = false;
  let clock = 0;
  let held: ((r: ProxiedRequest) => boolean) | undefined;
  let releases: Array<() => void> = [];
  const scripted: Array<{ match: (r: ProxiedRequest) => boolean; answer: ScriptedAnswer; left: number }> = [];
  const unanswering: Array<{ match: (r: ProxiedRequest) => boolean; left: number }> = [];
  const losing: Array<{ match: (r: ProxiedRequest) => boolean; left: number }> = [];
  let pieceBytes: number | undefined;
  /** Each stream still open, by the request it answers, in the order they opened: what `carry` writes onto. */
  const open = new Map<ProxiedRequest, (event: Buffer) => void>();

  const wake = () => {
    const waiting = waiters;
    waiters = [];
    for (const w of waiting) w();
  };

  const answeredNow = (recorded: ProxiedRequest, retryAfter: unknown): void => {
    recorded.answered = ++clock;
    recorded.answeredMs = performance.now();
    const seconds = Number(retryAfter);
    recorded.retryAfter = retryAfter !== undefined && Number.isFinite(seconds) ? seconds : undefined;
  };

  /** Writes a stream's chunk in pieces of `pieceBytes`, each on a turn of its own so each leaves in a segment of its own. */
  const inPieces = async (res: ServerResponse, chunk: Buffer, size: number): Promise<void> => {
    for (let at = 0; at < chunk.length && !res.destroyed; at += size) {
      res.write(chunk.subarray(at, at + size));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  /** The request as the client sent it, addressed to the gateway. */
  const toGateway = (recorded: ProxiedRequest) => ({
    host: gateway.hostname,
    port: gateway.port,
    path: recorded.path,
    method: recorded.method,
    headers: { ...recorded.headers, host: gateway.host },
  });

  const forward = (recorded: ProxiedRequest, body: Buffer, res: ServerResponse): void => {
    const upstream = request(
      toGateway(recorded),
      (answer) => {
        recorded.status = answer.statusCode;
        answeredNow(recorded, answer.headers['retry-after']);
        wake();
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        // A stream's headers must reach the client before its first frame does.
        res.flushHeaders();
        answer.on('error', () => res.destroy());

        const type = mediaType(answer.headers);
        if (type !== 'text/event-stream') {
          const chunks: Buffer[] = [];
          if (type.endsWith('json')) {
            answer.on('data', (chunk: Buffer) => chunks.push(chunk));
            answer.on('end', () => {
              try {
                recorded.answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                recorded.answer = undefined;
              }
              wake();
            });
          }
          answer.pipe(res);
          return;
        }

        const reader = eventReader((event, id, data) => {
          recorded.events.push({ event, id, data, at: ++clock });
          wake();
        });
        res.socket?.setNoDelay(true);
        let writing = Promise.resolve();
        const write = (chunk: Buffer): void => {
          const size = pieceBytes;
          if (size === undefined) res.write(chunk);
          else writing = writing.then(() => inPieces(res, chunk, size));
        };
        // Events `carry` wrote while the gateway was midway through one of its own, written once it is done.
        let waiting: Buffer[] = [];
        const written = (): void => {
          for (const event of waiting) {
            write(event);
            reader.read(event);
          }
          waiting = [];
        };
        open.set(recorded, (event) => {
          waiting.push(event);
          if (reader.between()) written();
        });
        answer.on('data', (chunk: Buffer) => {
          reader.read(chunk);
          write(chunk);
          if (reader.between()) written();
        });
        answer.on('end', () => void writing.then(() => res.end()));
        res.on('close', () => open.delete(recorded));
      },
    );
    upstream.on('error', () => res.destroy());
    // The client going away ends the gateway's half too, as it would unproxied.
    res.on('close', () => upstream.destroy());
    upstream.end(body);
  };

  /** Passes a request on and records the gateway's whole answer before closing the client's connection with none of it written. */
  const forwardAndLose = (recorded: ProxiedRequest, body: Buffer, res: ServerResponse): void => {
    const upstream = request(toGateway(recorded), (answer) => {
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('error', () => res.destroy());
      answer.on('end', () => {
        recorded.status = answer.statusCode;
        recorded.answerLost = true;
        answeredNow(recorded, answer.headers['retry-after']);
        try {
          recorded.answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          recorded.answer = undefined;
        }
        res.destroy();
        wake();
      });
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    upstream.end(body);
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
      const recorded: ProxiedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        json,
        status: undefined,
        arrived: ++clock,
        answered: undefined,
        arrivedMs: performance.now(),
        answeredMs: undefined,
        retryAfter: undefined,
        answer: undefined,
        events: [],
        closed: false,
        answerLost: false,
      };
      requests.push(recorded);
      wake();
      res.on('close', () => {
        recorded.closed = true;
        wake();
      });

      const script = scripted.find((s) => s.left > 0 && s.match(recorded));
      if (script) {
        script.left--;
        recorded.status = script.answer.status;
        answeredNow(recorded, script.answer.headers['retry-after']);
        try {
          recorded.answer = JSON.parse(script.answer.body);
        } catch {
          recorded.answer = undefined;
        }
        wake();
        res.writeHead(script.answer.status, script.answer.headers);
        res.end(script.answer.body);
        return;
      }
      const dropping = unanswering.find((u) => u.left > 0 && u.match(recorded));
      if (dropping) {
        dropping.left--;
        res.destroy();
        return;
      }
      const lost = losing.find((l) => l.left > 0 && l.match(recorded));
      if (lost) {
        lost.left--;
        forwardAndLose(recorded, body, res);
        return;
      }
      if (held?.(recorded)) releases.push(() => forward(recorded, body, res));
      else forward(recorded, body, res);
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

  const until = async <T>(what: string, probe: () => T | undefined, timeoutMs = 10_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = probe();
      if (found !== undefined) return found;
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
  };

  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    now: () => clock,
    until,
    next: (what, match, timeoutMs = 10_000, from = 0) => until(what, () => requests.slice(from).find(match), timeoutMs),
    cut,
    down() {
      refusing = true;
      cut();
    },
    up() {
      refusing = false;
    },
    hold(match) {
      held = match;
    },
    release() {
      held = undefined;
      const waiting = releases;
      releases = [];
      for (const go of waiting) go();
    },
    answer(match, answer, times) {
      scripted.push({ match, answer, left: times });
    },
    leaveUnanswered(match, times) {
      unanswering.push({ match, left: times });
    },
    loseAnswer(match, times) {
      losing.push({ match, left: times });
    },
    rechunk(bytes) {
      pieceBytes = bytes;
    },
    carry(data) {
      const streams = [...open.values()];
      const last = streams.at(-1);
      if (last === undefined) throw new Error('no stream is open to carry the frame');
      last(Buffer.from(`event: bus-event\ndata: ${data}\n\n`));
    },
    close: () =>
      new Promise<void>((resolve) => {
        cut();
        server.close(() => resolve());
      }),
  };
}
