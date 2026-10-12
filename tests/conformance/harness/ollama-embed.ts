/**
 * A stand-in embedding provider: the one call a Smelter makes of an Ollama,
 * `POST /api/embed` with a model and a list of texts, answered with a vector
 * for each text. A vector is worked out from its text alone, so the same text
 * has the same vector however often it is asked for, and two texts have two.
 *
 * It answers every request, unasked. A case scripts only what it wants to go
 * otherwise: a 404, as an Ollama answers for a model it has not fetched; any
 * other failing status; or a request held, accepted and not answered until
 * the case says. Every request is recorded as it was sent, with what it was
 * answered, and a case that wants only what came after some point marks the
 * point and asks for what was sent since.
 *
 * A request of any other path, and a body that is not a model and a list of
 * texts, lands in `violations`, which fail the case whatever it was about.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** How wide every vector of the stand-in is. */
export const EMBEDDING_WIDTH = 16;

/**
 * The vector the stand-in gives a text. Its length is 1: an index that
 * compares by cosine keeps a vector of length 1 as it was given, so a point's
 * vector can be held to this one.
 */
export function embeddingOf(text: string): number[] {
  const digest = createHash('sha256').update(text, 'utf8').digest();
  const raw = Array.from(digest.subarray(0, EMBEDDING_WIDTH), (byte) => byte - 127.5);
  const length = Math.hypot(...raw);
  return raw.map((n) => n / length);
}

/** Whether two vectors are the same, to the single precision an index stores one in. */
export function sameEmbedding(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => Math.abs(n - b[i]!) < 1e-5);
}

/** What the stand-in does with one request, in place of answering it with its vectors. */
export type ScriptedEmbedding =
  /** The provider refused: this status, this body. */
  | { status: number; body: string }
  /** The request is accepted and not answered until `release()`, or until the Smelter gives up on it. */
  | { hold: true };

/** What an Ollama answers for a model it has not fetched. */
export const NOT_FETCHED: ScriptedEmbedding = { status: 404, body: JSON.stringify({ error: 'model not found, try pulling it first' }) };

/** One `POST /api/embed`, as it arrived. */
export interface RecordedEmbedding {
  /** The body, parsed. */
  body: Record<string, unknown>;
  /** The model it named. */
  model: string;
  /** The texts it asked the vectors of, in order. */
  texts: string[];
  /** The status it was answered with; undefined while it is held, and when it was never answered. */
  status: number | undefined;
  /** Whether the Smelter ended the connection before it was answered. */
  abandoned: boolean;
}

export interface StandInEmbedder {
  /** What a Smelter's settings name as its provider's address. */
  readonly origin: string;
  /** Every `POST /api/embed`, in order. */
  readonly requests: RecordedEmbedding[];
  /** Everything the Smelter asked that the stand-in does not serve. */
  readonly violations: string[];
  /** A point a case marks: how many requests have arrived by now. */
  mark(): number;
  /** The requests that arrived after a mark, in order. */
  since(mark: number): RecordedEmbedding[];
  /** How many requests are held now. */
  readonly held: number;
  /** What the next requests get in place of their vectors, in order, after those already scripted. */
  script(...replies: ScriptedEmbedding[]): void;
  /**
   * Answer by what was asked, for a case whose requests arrive in no fixed
   * order: `choose` is given each request, and what it returns is done with
   * it. A request it returns nothing for takes the next scripted reply, or
   * its vectors.
   */
  choose: ((request: RecordedEmbedding) => ScriptedEmbedding | undefined) | undefined;
  /** Answer every held request with its vectors. */
  release(): void;
  /** Forget what was scripted and recorded, and end every held request unanswered: the next case starts clean. */
  reset(): void;
  close(): Promise<void>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A request's body, when it is a model and a list of texts. */
function asked(text: string): Pick<RecordedEmbedding, 'body' | 'model' | 'texts'> | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(body)) return undefined;
  const model = body['model'];
  const input: unknown = body['input'];
  if (typeof model !== 'string' || !Array.isArray(input)) return undefined;
  const texts = input.filter((one): one is string => typeof one === 'string');
  return texts.length === input.length ? { body, model, texts } : undefined;
}

export async function startOllamaEmbed(): Promise<StandInEmbedder> {
  const requests: RecordedEmbedding[] = [];
  const violations: string[] = [];
  const scripted: ScriptedEmbedding[] = [];
  const holding: Array<{ res: ServerResponse; embedded: () => void }> = [];
  const sockets = new Set<Socket>();
  let choose: StandInEmbedder['choose'];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const json = (status: number, payload: string) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      };

      if (req.method !== 'POST' || req.url !== '/api/embed') {
        violations.push(`${req.method} ${req.url}, which the stand-in embedding provider does not serve`);
        return json(404, JSON.stringify({ error: 'not found' }));
      }
      const sent = asked(text);
      if (sent === undefined) {
        violations.push(`an embedding request that is not a model and a list of texts: ${text.slice(0, 200)}`);
        return json(400, JSON.stringify({ error: 'not a model and a list of texts' }));
      }

      const recorded: RecordedEmbedding = { ...sent, status: undefined, abandoned: false };
      requests.push(recorded);
      res.on('close', () => {
        if (!res.writableEnded) recorded.abandoned = true;
      });
      const answer = (status: number, payload: string) => {
        recorded.status = status;
        json(status, payload);
      };
      const embedded = () => answer(200, JSON.stringify({ model: recorded.model, embeddings: recorded.texts.map(embeddingOf) }));

      const reply = choose?.(recorded) ?? scripted.shift();
      if (reply === undefined) return embedded();
      if ('hold' in reply) {
        holding.push({ res, embedded });
        return;
      }
      answer(reply.status, reply.body);
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
    requests,
    violations,
    mark: () => requests.length,
    since: (mark) => requests.slice(mark),
    get held() {
      return holding.filter(({ res }) => !res.destroyed).length;
    },
    script: (...replies) => void scripted.push(...replies),
    get choose() {
      return choose;
    },
    set choose(next) {
      choose = next;
    },
    release() {
      for (const { res, embedded } of holding.splice(0)) if (!res.destroyed) embedded();
    },
    reset() {
      for (const { res } of holding.splice(0)) res.destroy();
      scripted.length = 0;
      requests.length = 0;
      violations.length = 0;
      choose = undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
