/**
 * A stand-in Anthropic: the two calls a worker's Anthropic agent makes,
 * answered from what a case scripted. `GET /v1/models/{model}` answers what
 * the case said of the model. `POST /v1/messages` is a generation, and takes
 * the next scripted reply: as one JSON message, or as a stream of events when
 * the request asks for one (`stream: true`). Every request is recorded as it
 * was sent, with its headers, so a case can hold a worker to the exact request
 * it made and to how many times it made it.
 *
 * It plays the provider under version 2026-10-21 of its API. A request is
 * taken only with the key as `Authorization: Bearer <key>`, and is otherwise
 * answered 401. A generation that carries `temperature`, `top_p` or `top_k`
 * is refused on every model, as the provider refuses one: with 400, saying
 * so.
 *
 * A request no case scripted, a request of any other path, a request about a
 * model the case has not described, a request without the key, and a
 * generation that carries `temperature`, `top_p` or `top_k` lands in
 * `violations`, which fail the case whatever it was about.
 */
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { freePort } from './net';

/** What the provider says of a model. */
export interface ModelFacts {
  /** `max_input_tokens`: what it reads. */
  maxInputTokens: number;
  /** `max_tokens`: the most it writes in one answer. */
  maxOutputTokens: number;
  /** What it reports as `capabilities.structured_outputs.supported`. */
  structuredOutputs: boolean;
}

/** What the stand-in does with one generation. */
export type ScriptedMessage =
  /**
   * The model answered `text`, and stopped for `stopReason` (`end_turn` unless
   * said). `usage` is the token counts every answer of the provider states.
   */
  | { text: string; usage: { input: number; output: number }; stopReason?: string }
  /** The provider refused: this status and this body, with these headers beside its own. */
  | { status: number; body: string; headers?: Record<string, string> }
  /** The request is accepted and not answered until `release()`, or until the worker gives up on it. */
  | { hold: true }
  /** The connection is ended with no answer. */
  | { drop: true };

/** What the stand-in refuses a request with: this status, with these headers beside its own. */
export interface Refusal {
  status: number;
  headers?: Record<string, string>;
}

/** One request, as it arrived. */
export interface RecordedRequest {
  method: string;
  path: string;
  /** Its headers, their names in lower case. */
  headers: IncomingHttpHeaders;
  /** Its body, parsed; `undefined` when it had none. */
  body: unknown;
  /** When it arrived, in milliseconds since the epoch. */
  at: number;
  /** Whether the worker ended the connection before it was answered. */
  abandoned: boolean;
}

/** One generation, as it arrived. */
export interface RecordedMessage extends RecordedRequest {
  body: Record<string, unknown>;
}

export interface StandInAnthropic {
  /** What a worker's `baseUrl` names. */
  readonly origin: string;
  /** The key a request must carry, as `Authorization: Bearer <key>`. */
  readonly apiKey: string;
  /** What the provider says of each model it has, by the model's name. A model it lacks is answered 404. */
  readonly models: Map<string, ModelFacts>;
  /** What the Models API refuses every request with, when a case says it does. */
  modelsRefusal: Refusal | undefined;
  /** Every request, in order. */
  readonly requests: RecordedRequest[];
  /** Every `GET /v1/models/{model}`, in order. */
  readonly described: RecordedRequest[];
  /** Every generation, in order. */
  readonly generations: RecordedMessage[];
  /** Everything the worker asked that no case scripted. */
  readonly violations: string[];
  /** The replies the next generations get, in order, after those already scripted. */
  script(...replies: ScriptedMessage[]): void;
  /**
   * Answer by what was asked, for a case whose requests arrive in no fixed
   * order: `choose` is given each generation's body, and what it returns is the
   * reply. A request it returns nothing for takes the next scripted reply.
   */
  choose: ((body: Record<string, unknown>) => ScriptedMessage | undefined) | undefined;
  /** Resolves once `count` generations have arrived. */
  asked(count: number, timeoutMs?: number): Promise<void>;
  /** Answer every held generation: with `reply`, or with what `reply` makes of its body. */
  release(reply: ScriptedMessage | ((body: Record<string, unknown>) => ScriptedMessage)): void;
  /** Forget what was scripted and recorded, and say of each model what was said when the stand-in started. */
  reset(): void;
  close(): Promise<void>;
}

/** How many code points of an answer one event of a stream carries. */
const STREAMED_PIECE = 24;

/** What the provider refuses in a generation under version 2026-10-21 of its API, on every model and at any value. */
const SAMPLING = ['temperature', 'top_p', 'top_k'] as const;

const refusal = (type: string, message: string): string => JSON.stringify({ type: 'error', error: { type, message } });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stand-in that has `models`, each as `facts` says, and takes `apiKey`. */
export async function startAnthropic(apiKey: string, models: readonly string[], facts: ModelFacts): Promise<StandInAnthropic> {
  const known = new Map<string, ModelFacts>();
  const requests: RecordedRequest[] = [];
  const described: RecordedRequest[] = [];
  const generations: RecordedMessage[] = [];
  const violations: string[] = [];
  const scripted: ScriptedMessage[] = [];
  const held: Array<{ res: ServerResponse; body: Record<string, unknown> }> = [];
  /** The answers the stand-in itself ended: a connection it dropped was not given up by the worker. */
  const dropped = new WeakSet<ServerResponse>();
  const sockets = new Set<Socket>();
  let answered = 0;
  let waiters: Array<() => void> = [];
  const wake = () => {
    const waiting = waiters;
    waiters = [];
    for (const w of waiting) w();
  };
  const describe = () => {
    known.clear();
    for (const model of models) known.set(model, { ...facts });
  };
  describe();

  let modelsRefusal: Refusal | undefined;
  let choose: StandInAnthropic['choose'];

  /** Send `reply` as the answer to a generation that asked with `body`. */
  const answer = (res: ServerResponse, body: Record<string, unknown>, reply: ScriptedMessage): void => {
    if (res.destroyed) return;
    const id = `standin_${++answered}`;
    if ('hold' in reply) {
      held.push({ res, body });
      return;
    }
    if ('drop' in reply) {
      dropped.add(res);
      res.destroy();
      return;
    }
    if ('status' in reply) {
      res.writeHead(reply.status, { 'content-type': 'application/json', 'request-id': `req_${id}`, ...reply.headers });
      res.end(reply.body);
      return;
    }
    const stopReason = reply.stopReason ?? 'end_turn';
    const usage = { input_tokens: reply.usage.input, output_tokens: reply.usage.output };
    const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: body['model'], stop_sequence: null };
    if (body['stream'] !== true) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${id}` });
      res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: reply.text }], stop_reason: stopReason, usage }));
      return;
    }
    // A stream, as the provider sends one: the message opens empty, its text follows in pieces, and its stop reason and what it wrote come last.
    const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const points = Array.from(reply.text);
    const pieces = Array.from({ length: Math.ceil(points.length / STREAMED_PIECE) }, (_, i) => points.slice(i * STREAMED_PIECE, (i + 1) * STREAMED_PIECE).join(''));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${id}` });
    res.write(event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: reply.usage.input, output_tokens: 1 } } }));
    res.write(event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    for (const text of pieces) res.write(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }));
    res.write(event('content_block_stop', { index: 0 }));
    res.write(event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: reply.usage.output } }));
    res.end(event('message_stop', {}));
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      const recorded: RecordedRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body, at: Date.now(), abandoned: false };
      requests.push(recorded);
      res.on('close', () => {
        if (!res.writableEnded && !dropped.has(res)) recorded.abandoned = true;
      });
      const json = (status: number, payload: string) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      };
      const refuse = (how: Refusal, said: string) => {
        res.writeHead(how.status, { 'content-type': 'application/json', ...how.headers });
        res.end(refusal('api_error', said));
      };
      const what = `${recorded.method} ${recorded.path}`;

      if (req.headers['authorization'] !== `Bearer ${apiKey}`) {
        violations.push(`${what} without the key its agent's apiKeyEnv names, as \`Authorization: Bearer\``);
        return json(401, refusal('authentication_error', 'invalid bearer token'));
      }

      const model = /^\/v1\/models\/([^/?]+)$/.exec(recorded.path)?.[1];
      if (req.method === 'GET' && model !== undefined) {
        described.push(recorded);
        if (modelsRefusal !== undefined) return refuse(modelsRefusal, 'the stand-in refuses the Models API');
        const id = decodeURIComponent(model);
        const said = known.get(id);
        if (said === undefined) {
          violations.push(`${what}, a model the case has not described`);
          return json(404, refusal('not_found_error', `model: ${id}`));
        }
        return json(
          200,
          JSON.stringify({
            type: 'model',
            id,
            display_name: id,
            created_at: '2026-01-01T00:00:00Z',
            max_input_tokens: said.maxInputTokens,
            max_tokens: said.maxOutputTokens,
            capabilities: { structured_outputs: { supported: said.structuredOutputs } },
          }),
        );
      }

      if (req.method === 'POST' && recorded.path === '/v1/messages') {
        if (!isObject(body)) {
          violations.push(`a message whose body is not a JSON object: ${text.slice(0, 200)}`);
          return json(400, refusal('invalid_request_error', 'not a JSON object'));
        }
        const asked: RecordedMessage = Object.assign(recorded, { body });
        generations.push(asked);
        wake();
        if (!known.has(String(asked.body['model']))) {
          violations.push(`${what} of ${String(asked.body['model'])}, a model the case has not described`);
          return json(404, refusal('not_found_error', `model: ${String(asked.body['model'])}`));
        }
        const sampled = SAMPLING.filter((name) => name in asked.body).map((name) => `\`${name}\``);
        if (sampled.length > 0) {
          violations.push(`generation ${generations.length}, which carries ${sampled.join(', ')}`);
          return json(400, refusal('invalid_request_error', `${sampled.join(', ')}: this version of the API takes no sampling parameter, on any model`));
        }
        const reply = choose?.(asked.body) ?? scripted.shift();
        if (reply === undefined) {
          violations.push(`generation ${generations.length}, which no case scripted: ${JSON.stringify(asked.body['messages']).slice(0, 160)}`);
          return json(400, refusal('invalid_request_error', 'the stand-in has no reply scripted'));
        }
        return answer(res, asked.body, reply);
      }

      violations.push(`${what}, which the stand-in Anthropic does not serve`);
      json(404, refusal('not_found_error', 'not found'));
    });
    req.on('error', () => res.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${port}`,
    apiKey,
    models: known,
    get modelsRefusal() {
      return modelsRefusal;
    },
    set modelsRefusal(next) {
      modelsRefusal = next;
    },
    get choose() {
      return choose;
    },
    set choose(next) {
      choose = next;
    },
    requests,
    described,
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
      for (const { res, body } of held.splice(0)) answer(res, body, typeof reply === 'function' ? reply(body) : reply);
    },
    reset() {
      for (const { res } of held.splice(0)) {
        dropped.add(res);
        res.destroy();
      }
      scripted.length = 0;
      requests.length = 0;
      described.length = 0;
      generations.length = 0;
      violations.length = 0;
      modelsRefusal = undefined;
      choose = undefined;
      describe();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
