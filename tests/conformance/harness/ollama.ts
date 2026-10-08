/**
 * A stand-in Ollama: the two calls a worker's Ollama driver makes, answered
 * from what a case scripted. `POST /api/show` answers the context length the
 * case set; `POST /api/generate` answers the next scripted reply. Every
 * request is recorded as it was sent, so a case can hold a worker to the exact
 * prompt, model and options it asked with.
 *
 * A request no case scripted, and a request of any other path, lands in
 * `violations`, which fail the case whatever it was about.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** What the stand-in does with one `POST /api/generate`. */
export type ScriptedGeneration =
  /**
   * The model answered `response`, and stopped for `doneReason` (`stop` unless
   * said). `usage` is the token counts a real Ollama reports; without it the
   * answer carries none.
   */
  | { response: string; doneReason?: string; usage?: { prompt: number; output: number } }
  /** The provider refused: this status, this body. */
  | { status: number; body: string }
  /** The request is accepted and not answered until `release()`, or until the worker gives up on it. */
  | { hold: true }
  /** The connection is ended with no answer. */
  | { drop: true };

/** One `POST /api/generate`, as it arrived. */
export interface RecordedGeneration {
  /** The body, parsed. */
  body: Record<string, unknown>;
  /** Whether the worker ended the connection before it was answered. */
  abandoned: boolean;
}

export interface StandInOllama {
  /** What a worker's `baseUrl` names. */
  readonly origin: string;
  /** The context length `/api/show` reports, or the status it refuses with. */
  show: { contextLength: number } | { status: number };
  /** The body of every `POST /api/show`, in order. */
  readonly shows: unknown[];
  /** Every `POST /api/generate`, in order. */
  readonly generations: RecordedGeneration[];
  /** Everything the worker asked that no case scripted. */
  readonly violations: string[];
  /** The replies the next generations get, in order, after those already scripted. */
  script(...replies: ScriptedGeneration[]): void;
  /**
   * Answer by what was asked, for a case whose requests arrive in no fixed
   * order: `choose` is given each request's body, and what it returns is the
   * reply. A request it returns nothing for takes the next scripted reply.
   */
  choose: ((body: Record<string, unknown>) => ScriptedGeneration | undefined) | undefined;
  /** Resolves once `count` generations have arrived. */
  asked(count: number, timeoutMs?: number): Promise<void>;
  /** Answer every held generation with `reply`. */
  release(reply: { response: string; doneReason?: string }): void;
  /** Forget what was scripted and recorded: the next case starts clean. */
  reset(): void;
  close(): Promise<void>;
}

const generated = (reply: { response: string; doneReason?: string; usage?: { prompt: number; output: number } }): string =>
  JSON.stringify({
    response: reply.response,
    done: true,
    done_reason: reply.doneReason ?? 'stop',
    ...(reply.usage ? { prompt_eval_count: reply.usage.prompt, eval_count: reply.usage.output } : {}),
  });

export async function startOllama(contextLength = 8192): Promise<StandInOllama> {
  const shows: unknown[] = [];
  const generations: RecordedGeneration[] = [];
  const violations: string[] = [];
  const scripted: ScriptedGeneration[] = [];
  const held: ServerResponse[] = [];
  const sockets = new Set<Socket>();
  let waiters: Array<() => void> = [];
  const wake = () => {
    const waiting = waiters;
    waiters = [];
    for (const w of waiting) w();
  };

  let show: StandInOllama['show'] = { contextLength };
  let choose: StandInOllama['choose'];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const json = (status: number, payload: string) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      };

      if (req.method === 'POST' && req.url === '/api/show') {
        shows.push(body);
        if ('status' in show) return json(show.status, JSON.stringify({ error: 'the stand-in refuses /api/show' }));
        return json(200, JSON.stringify({ model_info: { 'general.architecture': 'standin', 'standin.context_length': show.contextLength } }));
      }

      if (req.method === 'POST' && req.url === '/api/generate') {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          violations.push(`a generation whose body is not a JSON object: ${text.slice(0, 200)}`);
          return json(400, JSON.stringify({ error: 'not a JSON object' }));
        }
        const recorded: RecordedGeneration = { body: body as Record<string, unknown>, abandoned: false };
        generations.push(recorded);
        res.on('close', () => {
          if (!res.writableEnded) recorded.abandoned = true;
        });
        wake();
        const reply = choose?.(recorded.body) ?? scripted.shift();
        if (reply === undefined) {
          violations.push(`generation ${generations.length}, which no case scripted: ${String(recorded.body['prompt']).slice(0, 160)}`);
          return json(500, JSON.stringify({ error: 'the stand-in has no reply scripted' }));
        }
        if ('hold' in reply) {
          held.push(res);
          return;
        }
        if ('drop' in reply) {
          res.destroy();
          return;
        }
        if ('status' in reply) return json(reply.status, reply.body);
        return json(200, generated(reply));
      }

      violations.push(`${req.method} ${req.url}, which the stand-in Ollama does not serve`);
      json(404, JSON.stringify({ error: 'not found' }));
    });
    req.on('error', () => res.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get show() {
      return show;
    },
    set show(next) {
      show = next;
    },
    get choose() {
      return choose;
    },
    set choose(next) {
      choose = next;
    },
    shows,
    generations,
    violations,
    script: (...replies) => void scripted.push(...replies),
    async asked(count, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (generations.length < count) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out after ${timeoutMs} ms waiting for generation ${count} to be asked for: ${generations.length} arrived`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    release(reply) {
      for (const res of held.splice(0)) {
        if (res.destroyed) continue;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(generated(reply));
      }
    },
    reset() {
      for (const res of held.splice(0)) res.destroy();
      scripted.length = 0;
      shows.length = 0;
      generations.length = 0;
      violations.length = 0;
      show = { contextLength };
      choose = undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
